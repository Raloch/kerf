import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

/**
 * 接收自检结果并落盘。**只在 dev 存在**——`vite build` 的产物里没有这个路由。
 *
 * 为的是砍掉真机调试的往返成本：手机上跑完只能截图或长按复制再发过来，而截图
 * 会丢掉诊断字段（真正要看的往往不是断言红没红，是它旁边那些数）。配套的发送端
 * 是 `src/dev/autorun.ts`，用法 `?autorun=m0`。
 */
function reportSink(): Plugin {
  return {
    name: "kerf-report-sink",
    apply: "serve",
    configureServer(server) {
      const dir = resolve(server.config.root, ".reports");
      server.middlewares.use("/__report", (req, res, next) => {
        if (req.method !== "POST") return next();
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let name = "unknown";
          try {
            name = String((JSON.parse(body) as { name?: unknown }).name ?? "unknown");
          } catch {
            /* 存原文，解析失败也不丢数据 */
          }
          mkdirSync(dir, { recursive: true });
          // 文件名带序号而不是只带名字：同一个自检会跑好几遍，覆盖掉上一次
          // 恰好会毁掉"改之前 vs 改之后"的对比
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const file = resolve(dir, `${stamp}-${name}.json`);
          writeFileSync(file, body);
          server.config.logger.info(`[report] ${name} → .reports/${stamp}-${name}.json`);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

/**
 * 主 chunk 里不许有 mediabunny 和 PixiJS——把这条纪律变成一条会红的断言。
 *
 * **判据是模块图（`chunk.moduleIds`），不是在产物里 grep 包名。** 实测那个代理
 * 两个方向都是坏的：`grep -c mediabunny` 在**真的就是 mediabunny 的那个 chunk**
 * （311KB 的 `id3-*.js`）上同样返回 **0**——压缩把包名整个丢掉了，所以拿它当判据
 * 是一条恒为真的假断言，无论有没有被拖进主 chunk 都报"没有"；反过来 `pixi` 在
 * 主 chunk 里出现 5 次，全部来自我们自己的动态 import 路径和 `backend: "pixi"`
 * 这个字符串，也就是说它连"有没有"都答不对。
 *
 * 还要**自证**：如果整个产物里一个受管库的模块都找不到，那说明判据本身坏了
 * （依赖换名了、路径形状变了、或者它被整个树摇掉了），这时也要红——不然这条
 * 断言会安静地退化成恒为真，而那正是上面那个 grep 的下场。
 *
 * 读数照印（入口 chunk 多大、每个受管库落在哪个 chunk），因为"没被拖进来"和
 * "拖进来了但总量恰好没变"在一句"通过"里长得一样。
 */
const GUARDED_DEPS = ["mediabunny", "pixi.js"] as const;
/** 入口模块。改名的话这个插件报"它不是应用入口"并失败，而不是悄悄检查一个别的 chunk */
const APP_ENTRY = "src/main.tsx";

function bundleGuard(): Plugin {
  return {
    name: "kerf-bundle-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((out) => (out.type === "chunk" ? [out] : []));
      // Worker 走的是另一趟构建（`worker.plugins` 是独立的一组），所以这一趟恰好
      // 只有应用这一个入口——导出 Worker 里那份 mediabunny 本来就该在，不参与判定。
      // 多出入口就说明构建结构变了，那时要重新想"哪个才是主 chunk"，不能蒙一个。
      const entries = chunks.filter((c) => c.isEntry);
      const entry = entries[0];
      if (entries.length !== 1 || entry === undefined) {
        this.error(
          `[bundle-guard] 期望恰好一个入口 chunk，实际 ${entries.length} 个` +
            `（${entries.map((c) => c.fileName).join(", ")}）。构建结构变了，` +
            `"主 chunk 是哪个"要重新定，这条断言在那之前不成立。`,
        );
        return;
      }
      if (!entry.moduleIds.some((id) => id.replace(/\\/g, "/").includes(`/${APP_ENTRY}`))) {
        this.error(
          `[bundle-guard] 入口 chunk ${entry.fileName} 里没有 ${APP_ENTRY}，它不是应用入口。` +
            `判据在恢复之前不成立——不然会去检查一个跟首屏无关的 chunk 并报"通过"。`,
        );
        return;
      }

      const holds = (chunk: (typeof chunks)[number], dep: string): boolean =>
        chunk.moduleIds.some((id) => id.replace(/\\/g, "/").includes(`/node_modules/${dep}/`));

      const lines: string[] = [];
      const offenders: string[] = [];
      const brokenJudge: string[] = [];
      for (const dep of GUARDED_DEPS) {
        const carriers = chunks.filter((c) => holds(c, dep));
        if (carriers.length === 0) brokenJudge.push(dep);
        if (holds(entry, dep)) offenders.push(dep);
        lines.push(
          `  ${dep}: ${carriers.length === 0 ? "产物里找不到" : carriers.map((c) => c.fileName).join(", ")}`,
        );
      }

      const size = Buffer.byteLength(entry.code, "utf8");
      this.info(`[bundle-guard] 入口 ${entry.fileName} = ${size.toLocaleString()} B\n${lines.join("\n")}`);

      if (brokenJudge.length > 0) {
        this.error(
          `[bundle-guard] 判据坏了：整个产物里找不到 ${brokenJudge.join(" / ")} 的任何模块。` +
            `这条断言在此之前一直靠"能在别处找到它"证明自己有牙齿，现在证明不了了——` +
            `先确认依赖还在、路径形状没变，再谈主 chunk 干不干净。`,
        );
      }
      if (offenders.length > 0) {
        this.error(
          `[bundle-guard] ${offenders.join(" / ")} 被拖进了主 chunk（${entry.fileName}）。` +
            `它们只能出现在 Worker 里或被动态 import()——拆分模式见 CLAUDE.md「首屏体积」：` +
            `把"要这个库的那一半"单独成文件，靠文件边界隔离，不能靠调用点。`,
        );
      }
    },
  };
}

/**
 * `--mode device` 是**给真机自检用的**（`pnpm dev:device`）：监听局域网 + 自签 HTTPS。
 *
 * HTTPS 不是可选项。WebCodecs 和 OPFS 都要求**安全上下文**，而 `localhost` 算安全、
 * `http://192.168.x.x` 不算——手机上直接开局域网地址会得到"没有 VideoEncoder"，
 * 看起来像"这台设备不支持"，实际上只是没走 HTTPS。这个坑不提前解决，就要等到
 * 人已经拿着手机站在那儿了才发现。
 *
 * 自签证书 iOS Safari 会拦一道（"此连接非私人连接" → 显示详细信息 → 继续访问），
 * 点过去就行。缺省的 `pnpm dev` 不开这些，免得桌面开发天天看证书警告。
 */
export default defineConfig(({ mode }) => ({
  plugins: [react(), reportSink(), bundleGuard(), ...(mode === "device" ? [basicSsl()] : [])],
  ...(mode === "device" ? { server: { host: true } } : {}),
  worker: {
    // 导出 Worker 用 ESM，才能直接 import mediabunny
    format: "es",
  },
  test: {
    // 时间基是纯计算，不需要浏览器环境
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
}));
