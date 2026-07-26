# Kerf

浏览器视频剪辑器，**导出在客户端完成**。服务端导出不在范围内，不要提议。

完整方案：[docs/PLAN.md](docs/PLAN.md)（选型理由、架构、兼容矩阵、决策记录、里程碑）
界面设计稿：[design/kerf-editor-mockup.html](design/kerf-editor-mockup.html)（已定稿，四种状态）

当前阶段：**M1.5 导出闭环已完成**（编辑器骨架 + EDL 驱动的导出：多片段/多轨取帧、空档黑帧、多轨混音、流式写盘、导出面板），**M1.6 PixiJS 后端 spike 已完成**（结论见 PLAN.md §7 M1.6 与 §6 的 D5）。

下一步 M2 创作能力，按 D5 分两段：先在 Canvas2D 上做文字层 / 关键帧 / 基础转场，滤镜和 shader 转场之前再换 Pixi 后端。**换后端之前先把 `ComposeLayer` 扩成渲染后端无关的描述**（加文字层和变换），扩完再换实现——否则接口和后端一起动，自检报错时没有基准可比。

```bash
pnpm dev          # 起开发服务器
pnpm test         # 跑单元测试（119 项：时间基 25 / 状态层 65 / 取样映射 15 / 预设 14）
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

## 导出层约定（M1.5 起）

- **预览和导出的取帧决策只能来自 `src/edl/sampling.ts`**。共用 `compose()` 只保证"画法一致"；"该画哪个片段、按什么顺序、读源片哪一刻"如果各写一套，画面照样不一致。三个函数是唯一入口：`sourceMicrosAt`（帧 → 源片时刻）、`videoTracksInDrawOrder`（z 序反转只有一处）、`visibleVideoClips`（某帧的图层）。
- **不要用 `toSourceFrame()` 做取帧位置**。它算的是帧号加减，隐含"源片帧率 = 时间轴帧率"。25fps 素材放到 30fps 时间轴上会慢 20% 且不报错。用 `sourceMicrosAt`。
- **`VideoTrackReader` 返回的 `VideoSample` 归 reader 所有，调用方不要 `close()`**。时间轴帧率高于源片帧率时同一个 sample 会被多个输出帧复用。
- **取帧只能向前**。倒着问会抛错——顺序解码是硬规则 3 的前提。
- **每条轨一份 `Input`**，哪怕同一个源文件：Input 的 demuxer 有读取位置，两条轨交错拉包会互相打乱。
- **音频混流只能在主线程**（`OfflineAudioContext` 在 Worker 里不可用），混好的 PCM 要 **transfer** 进 Worker，不能靠结构化克隆——几百 MB 会整份复制一遍。
- **导出预设按"每像素每帧比特数"定档，不写死码率**。写死过一次：360p 素材上「标准发布」仍按 10 Mbps 编，白扔 5 倍字节，而「存档母版」倒挂成最低档。
- **预设按短边封顶，不按高度**（`maxShortSide`）。竖屏的「1080p」是 1080×1920。按高度封顶过一次：1080×1920 被压成 608×1080，像素量只剩三分之一而标签仍写「1080p」，成品能播、比例也对，自检抓不到。见 PLAN.md 的 **D7**。
- **OPFS 目标在取消/失败时要自己删目录项**。`output.cancel()` 只 abort 内容，条目还在，会留 0 字节文件。picker 路径不能删——那是用户自己选的文件。

## 合成层约定（M1.6 起）

- **留边几何只有 `containRect()` 一处**。两个后端各算一遍就会在「预览 / 导出一致性自检」里差一两个像素，而那条断言要求黑边高度**完全相等**。
- **`pixi-compositor.ts` 对 pixi.js 只有 `import type`**，实例走函数里的动态 `import()`。所以谁静态 import 它都不会把 Pixi 拖进自己的 chunk——这和 mediabunny 的"文件边界"模式不同，靠的是**异步工厂 + 同步 `composeFrame`**。
- **Pixi 后端里临时 `VideoFrame` 必须在 `render()` 之后才 `close()`**。纹理上传发生在 render 期间；Canvas2D 的 `drawImage` 是立即的，所以那边"画完就关"是对的。从 Canvas2D 迁过来最容易踩这条，且不报错。
- **每个图层一个常驻 `ImageSource`，逐帧只换 `resource` 再 `update()`**。每帧 `Texture.from(frame)` 会逐帧新建 GPU 纹理，导出慢一个量级。自检里"GPU 纹理数不随帧数增长"就是锁这条。
- **锁 WebGL，不要 WebGPU**，也不要关 `preserveDrawingBuffer`（实测开销为零，见 PLAN.md §7 M1.6）。
- **Pixi 后端目前不接在预览和导出上**，只被 spike 自检使用。要接进去先读 PLAN.md 的 D5。

## 四个自检，改到相关地方就得跑

都在「M0 自检」面板里，`pnpm dev` 后从编辑器顶栏进。前三类错误**都不会报错**，只会静默产出错误的片子，单元测试覆盖不到。

| 改了什么 | 必须跑 |
|---|---|
| 导出管道 / 时间基 | **M0 自检**（16 项）：生成素材 → 探测 → 导出 trim 区间 → 读回断言 |
| 预览 / 合成 | **预览 / 导出一致性自检**（5 项）：同一帧两条路径逐像素比对 |
| 取帧映射 / EDL / 多轨 | **多片段一致性自检**（23 项）：两片段 + 空档整条导出后比对 7 个取样帧 |
| 合成层 / Pixi 后端 | **PixiJS 后端 spike**（11 项）：Worker 里起 WebGL，与 Canvas2D 跑同一份输入比对，外加两个只有 WebGL 才有的失效模式 |

第四个不是回归自检，是**换渲染后端之前必须成立的前提**——它跑在写 M2 功能代码之前，不是之后。

多片段自检能断言"取到的是源片第 N 帧"，靠的是测试素材背景色相随帧号线性渐变（`hue = i/frames*300`）——色相编码了源片帧号。**改 `make-sample.ts` 的配色就要同步改 `measure.ts` 的 `sampleHueAt`**，否则自检开始误报。

**M2 加文字层时，这套断言会被文字污染**（`measure()` 取的是画面区平均色）。方案已定：给 `measure()` 加可选矩形参数做**分区测量**——背景区继续断言色相、文字区做逐像素比对，不要"排除文字区域"（那等于没验文字）。自检素材里的文字用纯色实心块，不用真实文案。完整理由见 PLAN.md 的 **D6**。

另外预览 seek 要落在**帧中点**（`sourceCenterMicrosAt`），落在帧起点会拿到前一帧。

## 性能对比要在贴近真实的参数下测

**规模不对的基准量到的是固定开销，不是被测对象。** Pixi spike 第一版在 320×320 上跑，结论是 Pixi 比 Canvas2D 慢 **2.11×**；换到 1280×720 不缩放之后是 **0.97×**。小画布上每帧的固定开销（画布 → `VideoFrame` 的捕获、命令提交）占了大头，编码几乎没参与——那个 2.11× 量的是开销比例。

这类错误的代价不是跑错一次测试，是**因为一个便宜但不真实的基准砍掉正确的技术方向**。所以：

- 分辨率、帧数、是否缩放都要贴着导出的常态取，不要为了自检跑得快而缩小。
- 输入要**逐帧不同**。重复同一帧会让 H.264 编出极小的 P 帧，把编码成本压没，从而放大其它环节的占比。
- 只测"提交耗时"没有意义。GPU 是异步的，`renderer.render()` 返回时活还没干完——要计时就得测到真正强制同步的那一步（这里是 `CanvasSource.add()` 里的 `new VideoFrame(canvas)`）。

## 首屏体积

**mediabunny（约 500KB）不能进主 chunk。** 它只能出现在 Worker 里，或被动态 `import()`。已经踩过两次：一次是 `probe`/`capability`/`thumbnails` 静态 import，一次是导出面板经 `client.ts` → `mixdown.ts` 把它拖回来。判断方法是 `pnpm build` 看主 chunk——正常在 250KB 上下，出现 600KB+ 就是又被拖进来了。

拆分模式是**把"要 mediabunny 的那一半"单独成文件**：`capability.ts` / `capability-probe.ts`、`thumbnails.ts` / `thumbnail-extract.ts`。同步渲染路径上的函数（如 `drawStrip`）不能 await 动态 import，所以必须靠文件边界隔离，不能靠调用点。

**PixiJS 同理（412KB raw / gzip 119KB）。** 但它用的是另一个模式：`pixi-compositor.ts` 对 pixi.js 只有 `import type`，动态 `import()` 藏在 `createPixiCompositor()` 这个**异步工厂**里，返回的 `composeFrame()` 是同步的。边界划在"创建时"而不是"调用时"，因为调用点在 rAF 回调和导出逐帧循环里，每帧 await 不可接受。当前主 chunk 252,997 B（gzip 80,027），接 Pixi 之后这个数应该**一个字节都不变**。

## 技术栈（已定，不要另选）

| 用途 | 用什么 |
|---|---|
| 编解码 / 封装 / 转码 | mediabunny |
| 画面合成 / 滤镜 / 转场 | PixiJS v8（锁 WebGL2，不用 WebGPU；M2 后半段接入） |
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
9. **导出结果流式写盘，不要攒成 Blob。** 已落地：`StreamTarget` + `FileSystemWritableFileStream`，picker 拿到的句柄可直接 postMessage 进 Worker；没有 picker 的浏览器回退成"流式写 OPFS 再触发下载"。不要为了方便退回 `BufferTarget`。
10. **不静默降级导出格式。** 能力不足时明确告知用户后果并给出路——用户点了 MP4 却拿到 WebM 是投诉源。相关设计见 PLAN.md 的 D3。

## 改动设计时

界面设计决策记在 PLAN.md §6，四段格式（决定 / 理由 / 放弃了什么 / 什么情况下重新评估）。**改设计前先读那一节**——尤其"放弃了什么"，避免重新提一个已经被否掉的方案。新决策追加进去，别另起文档。
