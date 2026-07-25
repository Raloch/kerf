# Kerf

浏览器里的视频剪辑器，**导出全程在客户端完成**——素材不上传，不需要转码服务器。

> 状态：早期开发中。M0（端到端管道验证）已完成，编辑器界面尚未实现。

*kerf* 是锯片切过木料留下的那道缝。剪辑软件里最核心的动作就是这一刀。

---

## 现在能做什么

M0 的目标不是可用的编辑器，而是先证明这条链路成立：

```
解码 → 合成 → 编码 → 封装      全程 WebCodecs 硬件加速，跑在 Web Worker 里
```

跑起来后点「运行 M0 自检」，它会自动完成：生成一段带帧号水印的 300 帧素材 → 探测元信息 → 导出第 90–210 帧 → 把导出文件读回来断言 14 项（帧数、时长、帧率、音轨、首帧时间戳归零），并把导出的首末帧画到画布上，肉眼可确认裁剪起止精确到帧。

实测导出速度约 **8.7× 实时**（640×360，H.264 硬编）。

编辑器界面已经有可交互的设计稿，但还没实现——**[点开直接操作](https://raloch.github.io/kerf/)**：按空格播放、拖时间轴、点片段看检查器、走一遍导出流程。源文件在 [design/kerf-editor-mockup.html](design/kerf-editor-mockup.html)，单文件零依赖，clone 后双击也能打开。

## 快速开始

```bash
pnpm install
pnpm dev          # 打开页面，点「运行 M0 自检」
```

其他命令：

```bash
pnpm test         # 单元测试（时间基，25 项）
pnpm typecheck    # 类型检查（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）
pnpm build        # 生产构建
```

不需要准备视频文件——自检会自己合成测试素材。也可以用「选择视频文件」导入自己的片子。

## 浏览器要求

客户端导出依赖 WebCodecs，这是硬门槛：

| 浏览器 | 导出 MP4（H.264 + AAC） | 导出 WebM（VP9 + Opus） |
|---|---|---|
| Chrome / Edge 94+ | ✅ | ✅ |
| Safari 26+ | ✅ | ✅ |
| Firefox 130+ 桌面 | ❌ 不能编码 AAC | ✅ |
| Linux 桌面浏览器 | ❌ 不能编码 AAC | ✅ |
| Firefox Android | ❌ | ❌ |

缺少 AAC 编码能力时，界面会禁用 MP4 并就地说明原因，**不会静默换成别的格式**——用户点了 MP4 却拿到 WebM 是最糟的体验。

## 项目结构

```
src/
├─ time/        有理数帧号 ↔ 微秒 ↔ 时间码（含单元测试）
├─ edl/         EDL 类型定义：时间轴的唯一数据来源
├─ media/       编码能力探测、素材探针（帧率吸附）
├─ compose/     合成层，M0 用 Canvas2D，M2 换 PixiJS
├─ export/      导出流水线 + Worker + 进度/取消协议
├─ ui/          M0 验证面板（真正的编辑器 UI 在 M1）
└─ dev/         测试素材生成 + M0 自检脚本
design/         界面设计稿
docs/PLAN.md    技术方案（活文档）
```

## 几个刻意的技术选择

**预览和导出共用同一个 `compose(edl, frame)`。** 不允许存在两套渲染路径——这是"预览和导出画面不一致"的唯一根因。

**时间一律用有理数帧号，不用浮点秒。** 29.97fps 实际是 30000/1001，用浮点近似做帧运算会累积误差；实测用 `round(fps)` 代替有理数，10 分钟内就错位 18 帧。浮点秒只允许出现在调用底层库的那一行。

**导出取帧用 `VideoDecoder` 顺序解码，不用 `video.currentTime`。** 后者不帧精确，而且锁死在 1× 实时速度，做不了导出。

**不把 ffmpeg.wasm 放主路径。** 软编慢 10–50 倍，多线程版需要 COOP/COEP 响应头，会打断页面内的第三方脚本和跨域 iframe。

技术栈：[mediabunny](https://mediabunny.dev/)（编解码与封装）· PixiJS v8（合成，M2 起）· React + Vite · Zustand + Immer（M1 起）。选型理由和评估过但没选的方案见 [docs/PLAN.md](docs/PLAN.md)。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 端到端管道 + 时间基模型 | ✅ 已完成 |
| M1 | EDL 状态、撤销栈、多轨时间轴、磁吸、代理文件 | 未开工 |
| M2 | 文字/字幕、关键帧动画、转场、滤镜、音量包络 | 未开工 |
| M3 | 长视频内存压测、崩溃恢复、流式写盘、导出预设 | 未开工 |

## 文档

- [docs/PLAN.md](docs/PLAN.md) — 技术方案：选型理由、架构、兼容矩阵、设计决策记录、实施中踩到的坑
- [界面设计稿](https://raloch.github.io/kerf/) — 可交互，一个应用外壳承载剪辑台、素材导入、导出三态与兼容降级四种状态（源文件：[design/kerf-editor-mockup.html](design/kerf-editor-mockup.html)）
- [CLAUDE.md](CLAUDE.md) — 给 AI 编码助手的项目规则与硬约束

## 许可

[MIT](LICENSE)
