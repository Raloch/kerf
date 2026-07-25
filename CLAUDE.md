# Kerf

浏览器视频剪辑器，**导出在客户端完成**。服务端导出不在范围内，不要提议。

完整方案：[docs/PLAN.md](docs/PLAN.md)（选型理由、架构、兼容矩阵、决策记录、里程碑）
界面设计稿：[design/kerf-editor-mockup.html](design/kerf-editor-mockup.html)（已定稿，四种状态）

当前阶段：**M1 已完成**（编辑器骨架可用：导入、多轨时间轴、拖拽/裁切/磁吸、预览播放、OPFS 代理与缩略图）。下一步 M2 创作能力（文字层、关键帧、转场、滤镜、音量包络 + 音频波形）。

```bash
pnpm dev          # 起开发服务器
pnpm test         # 跑单元测试（时间基 25 项 + 状态层 65 项）
pnpm typecheck    # 类型检查，严格模式
pnpm build        # 构建
```

## 状态层约定（M1 起）

- **改 Timeline 只能走 `useTimeline` 的 action**，它们内部统一经 `apply()` 进撤销栈。绕过去直接 `set({ history })` 会产生撤销不了的编辑，是最难查的一类 bug。
- **编辑逻辑写在 `src/state/operations.ts` 的纯函数里**，不要写进组件或 store。那里能脱离浏览器单测，而移动/裁切/切分的边界条件多到必须靠测试锁死。
- **同一轨道内片段永不重叠**，这是核心不变量。越界操作返回 `changed:false` + `reason`，不要静默失败。
- **播放头和选中不进撤销栈**；但撤销后要清掉指向已不存在片段的选中。
- 连续拖拽必须传带对象标识的合并键（`move:${clipId}`），否则用户要按几十次 ⌘Z。

## UI 约定（M1 起）

- **新增样式文件先作用域化**：`app.css` 限定 `.m0`、`editor.css` 限定 `.ed`。曾因 `app.css` 里的 `label` / `button` 裸选择器和同名 `.caps` 类，把编辑器状态栏和缩放滑块变成纵向排列。
- **像素与帧的换算只有一处**（`Timeline` 的 `pxPerFrame`），位置一律由帧号乘它算出。不要缓存像素值再反推帧号，缩放后必错。
- 改完 UI 要在浏览器里实测，不能只看类型通过——布局 bug（撑爆容器、播放头错位、文字重叠）只有渲染出来才看得见。
- **浏览器实测要用 `window.__kerfStore`**（dev 环境自动挂载），不要在脚本里 `import('/src/state/timeline-store.ts')`：Vite 的 HMR URL 带参数，动态 import 会拿到**另一个模块实例**，脚本改了状态界面毫无反应，看起来像 UI 没绑定 store。
- 拖拽类交互要**同时测水平和垂直**：跨轨道是纯垂直移动，只测水平会漏掉阈值判定的 bug。

**改动预览或合成后，必须跑「预览 / 导出一致性自检」**（M0 自检面板里）：它用同一帧分别走两条路径逐像素比对，是硬规则 2 唯一的自动护栏。另外预览 seek 要落在**帧中点**（`frameCenterSeconds`），落在帧起点会拿到前一帧。

**改动导出管道或时间基后，必须跑 M0 自检**：`pnpm dev` → 页面上点「运行 M0 自检」，它会生成素材、导出 trim 区间、读回断言 14 项。帧数/时长/trim 起点错了不会报错，只会静默产出错误的片子，单元测试也覆盖不到——只有这个自检能发现。

## 技术栈（已定，不要另选）

| 用途 | 用什么 |
|---|---|
| 编解码 / 封装 / 转码 | mediabunny |
| 画面合成 / 滤镜 / 转场 | PixiJS v8 |
| 音频离线混流 | OfflineAudioContext |
| 状态 / 撤销栈 | Zustand + Immer |
| 大文件存储 | OPFS + File System Access API |
| 预览代理转码 | mediabunny `Conversion`（Worker 内，串行） |
| 时间轴、检查器、波形、导出面板 | 自研 |

ffmpeg.wasm 不进主路径（软编慢 10–50×，多线程版的 COOP/COEP 会打断页面内第三方脚本）。要补 AAC 只考虑 libav.js，且属于待定项。

## 硬规则

这几条错了要重写大片代码，动到相关地方先对照一遍：

1. **时间计算一律用有理数帧号（`num/den`）+ 微秒时间戳。禁止用浮点秒做帧运算。** 浮点秒只允许出现在调用 mediabunny（以秒为单位）的那一行。另外：拿"算出来的秒"和"解码器给的 `sample.timestamp`"比较时，必须带上 `FRAME_ALIGN_EPSILON_SECONDS` 容差，否则 trim 末帧会静默少一帧。
2. **预览和导出必须共用同一个 `compose(edl, frame)`。** 不允许出现两套渲染路径——这是"预览和导出画面不一致"的唯一根因。
3. **导出取帧必须用 `VideoDecoder` 顺序解码。禁止用 `video.currentTime` seek。** 它不帧精确，且锁在 1x 实时速度。预览走 seek + 代理文件没问题。
4. **每个 `VideoFrame` 都必须 `.close()`。** 它是 GPU 资源，漏一个几秒内 OOM。走池化的"借出—归还"，不要靠 GC。
5. **必须 `await source.add(...)`。** mediabunny 的 add() 在编码器就绪时才 resolve，await 它就是背压；不 await 会无限堆积帧直到 OOM。不需要自己轮询 `encodeQueueSize`。
6. **解码 / 合成 / 编码全部在 Web Worker。** 主线程只跑 UI，否则导出期间界面完全卡死。注意 **`OfflineAudioContext` 在 Worker 里不可用**：M2 做多轨混音时 PCM 要在主线程算好再 transfer 进去。
7. **裁剪要处理 GOP 边界**：clip 起点通常不在关键帧上，必须回退到前一个 keyframe 解码再丢弃多余帧，否则 trim 花屏。用 `VideoSampleSink.samples(start, end)` 顺序解码，mediabunny 内部已做这件事；不要逐帧 `getSample()`，那会反复 seek，慢一个量级。
8. **时间轴时长按视频轨算**，不能用 `input.computeDuration()`——AAC 的 priming/padding 会让音轨更长，300 帧素材会被算成 303 帧。
9. **导出结果流式写盘，不要攒成 Blob。**（M0 暂用 BufferTarget 出内存，M1 换 StreamTarget 写盘）
10. **不静默降级导出格式。** 能力不足时明确告知用户后果并给出路——用户点了 MP4 却拿到 WebM 是投诉源。相关设计见 PLAN.md 的 D3。

## 改动设计时

界面设计决策记在 PLAN.md §6，四段格式（决定 / 理由 / 放弃了什么 / 什么情况下重新评估）。**改设计前先读那一节**——尤其"放弃了什么"，避免重新提一个已经被否掉的方案。新决策追加进去，别另起文档。
