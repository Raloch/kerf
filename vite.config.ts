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
  plugins: [react(), reportSink(), ...(mode === "device" ? [basicSsl()] : [])],
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
