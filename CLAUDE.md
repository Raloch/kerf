# Kerf

浏览器视频剪辑器，**导出在客户端完成**。服务端导出不在范围内，不要提议。

完整方案：[docs/PLAN.md](docs/PLAN.md)（选型理由、架构、兼容矩阵、决策记录、里程碑）
界面设计稿：[design/kerf-editor-mockup.html](design/kerf-editor-mockup.html)（已定稿，四种状态）

当前阶段：**M0 已完成**（decode → compose → encode → mux 跑通），下一步 M1 编辑器骨架。

```bash
pnpm dev          # 起开发服务器
pnpm test         # 跑单元测试（时间基，25 项）
pnpm typecheck    # 类型检查，严格模式
pnpm build        # 构建
```

**改动导出管道或时间基后，必须跑 M0 自检**：`pnpm dev` → 页面上点「运行 M0 自检」，它会生成素材、导出 trim 区间、读回断言 14 项。帧数/时长/trim 起点错了不会报错，只会静默产出错误的片子，单元测试也覆盖不到——只有这个自检能发现。

## 技术栈（已定，不要另选）

| 用途 | 用什么 |
|---|---|
| 编解码 / 封装 / 转码 | mediabunny |
| 画面合成 / 滤镜 / 转场 | PixiJS v8 |
| 音频离线混流 | OfflineAudioContext |
| 状态 / 撤销栈 | Zustand + Immer |
| 大文件存储 | OPFS + File System Access API |
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
