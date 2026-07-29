/**
 * 指认页：打开项目时读不动的素材停在这里（D37 第 2 刀）。
 * 布局按 design/kerf-home-mockup.html 的第三种状态实现。
 *
 * 三条来自决策的纪律：
 * - **指认结果按 `sourceId` 配对，不按顺序**：本组件的状态就是一张以 id 为键的表，
 *   所以"先指第二个再指第一个"配错人这件事在结构上不可能发生（D37 的失败形态之三）。
 * - **「指定文件…」走 `<input type=file>`**，不用 `showOpenFilePicker`。导出侧"Safari
 *   没有 picker"那条经验在这里不适用：文件**选取**所有浏览器都有原生入口，缺的只是
 *   "往磁盘写"。
 * - **跳过是破坏性的，所以要说出来**：片段被移除之后历史是干净的（快照不存撤销栈），
 *   第一次编辑落盘就写死了，撤销不回来。所以主按钮明说要跳过几个，而不是摆两个
 *   含糊的按钮让人猜「打开项目」到底跳不跳。
 */

import { useCallback, useState } from "react";
import type { SourceId } from "../edl/types";
import type { ProjectInspection } from "../state/project-store";
import { UNNAMED_PROJECT } from "../state/project-snapshot";
import { checkReplacement, describeSourceMeta, reidentifiedFrom } from "../state/reidentify";
import type { MissingSource, Reidentified } from "../state/reidentify";
import { IconBack, IconCheck, IconFilm, IconImage, IconMark, IconWarn, IconWave } from "./icons";
import "./home.css";

export function Reidentify({
  inspection,
  onOpen,
  onBack,
}: {
  readonly inspection: ProjectInspection;
  /** 带着指认结果打开。没指认的那些，其片段会被 `fromSnapshot` 移除。 */
  readonly onOpen: (replacements: ReadonlyMap<SourceId, Reidentified>) => void;
  readonly onBack: () => void;
}) {
  /** **以 `sourceId` 为键**——顺序不是身份，见文件头。 */
  const [picked, setPicked] = useState<ReadonlyMap<SourceId, Reidentified>>(new Map());
  const [busyFor, setBusyFor] = useState<SourceId | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<SourceId, string>>>({});

  const projectName = inspection.name ?? UNNAMED_PROJECT;
  const remaining = inspection.missing.filter((m) => !picked.has(m.meta.id)).length;

  const pick = useCallback(
    async (missing: MissingSource, file: File) => {
      const id = missing.meta.id;
      setBusyFor(id);
      setErrors((prev) => {
        const { [id]: _gone, ...rest } = prev;
        return rest;
      });
      try {
        // 图片走另一个探针，它一行 mediabunny 都不用（见 `media/image-probe.ts`）
        const { looksLikeImage } = await import("../media/image-probe");
        const probed = looksLikeImage(file)
          ? (await (await import("../media/image-probe")).probeImageFile(file)).source
          : (await (await import("../media/probe")).probeFile(file)).source;

        const check = checkReplacement(missing.meta, probed, inspection.fps);
        if (!check.ok) {
          // 种类不一致是**指错了文件**，不是"换了一版素材"，所以拦住（见 reidentify.ts）
          setErrors((prev) => ({ ...prev, [id]: check.reason }));
          return;
        }
        // 探针新生成的 id 一律丢掉，换上要替换的那个——EDL 引用的是 id
        const next = reidentifiedFrom(id, probed, check.warnings);
        setPicked((prev) => new Map(prev).set(id, next));
      } catch (error) {
        setErrors((prev) => ({
          ...prev,
          [id]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        setBusyFor(null);
      }
    },
    [inspection.fps],
  );

  return (
    <div className="hm">
      <div className="hm-top">
        <button type="button" className="ib" aria-label="返回首页" onClick={onBack}>
          <IconBack />
        </button>
        <div className="brand">
          <IconMark className="mark" />
          <b>KERF</b>
        </div>
        <div className="spacer" />
      </div>

      <div className="hm-body">
        <div className="reid">
          <div className="reid-hd">
            <h2>
              打开「{projectName}」之前，先指认 {inspection.missing.length} 个素材
            </h2>
            <p>
              {inspection.missing.length === 1 ? "这个文件" : "这些文件"}
              不在原来的位置了。浏览器只存了对磁盘上文件的引用，文件被移动、改名或改过内容之后就读不到了——素材本身从来没有被上传或复制。
            </p>
          </div>

          <div className="reid-list">
            {inspection.missing.map((missing) => (
              <Row
                key={missing.meta.id}
                missing={missing}
                inspection={inspection}
                picked={picked.get(missing.meta.id)}
                busy={busyFor === missing.meta.id}
                error={errors[missing.meta.id]}
                onPick={(file) => void pick(missing, file)}
              />
            ))}
          </div>

          <div className="reid-foot">
            {/* 跳过是破坏性的，而且撤销不回来——只在真的会跳过时才说 */}
            {remaining > 0 && (
              <span className="note">跳过＝放弃那些片段，而且一开始编辑就会落盘，撤销不回来</span>
            )}
            <div className="spacer" />
            <button type="button" className="chip-btn" onClick={onBack}>
              返回首页
            </button>
            {/* 主按钮文案跟着状态走：摆两个并排的按钮时，「打开项目」到底跳不跳是含糊的 */}
            <button type="button" className="btn-primary" onClick={() => onOpen(picked)}>
              {remaining > 0 ? `跳过剩下的 ${remaining} 个并打开` : "打开项目"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  missing,
  inspection,
  picked,
  busy,
  error,
  onPick,
}: {
  readonly missing: MissingSource;
  readonly inspection: ProjectInspection;
  readonly picked: Reidentified | undefined;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onPick: (file: File) => void;
}) {
  const { meta, clips } = missing;
  const audio = meta.kind === "audio";
  // 选取范围跟着"种类必须一致"那条校验走：能选进来的就该是能收下的
  const accept = meta.kind === "av" ? "video/*" : meta.kind === "image" ? "image/*" : "audio/*";

  return (
    <div className={`reid-row ${audio ? "a" : "v"}${picked ? " done" : ""}`}>
      <span className="ic">
        {meta.kind === "av" ? <IconFilm /> : meta.kind === "image" ? <IconImage /> : <IconWave />}
      </span>
      <span className="txt">
        <span className="nm">
          {meta.name}
          {picked && (
            <>
              {" → "}
              <b>{picked.file.name}</b>
            </>
          )}
        </span>
        {/* 快照里的 SourceMeta 本来就存着尺寸/帧率/时长，所以文件读不回来也说得出它该是什么样 */}
        <span className="sub">
          {describeSourceMeta(meta, inspection.fps)} · 用在 {clips} 个片段
        </span>
        {picked?.warnings.map((warning) => (
          <span className="mismatch" key={warning}>
            <IconWarn />
            {warning}
          </span>
        ))}
        {error && (
          <span className="mismatch bad">
            <IconWarn />
            {error}
          </span>
        )}
      </span>
      {picked && (
        <span className="tick">
          <IconCheck />
        </span>
      )}
      {/*
        指认完的行**照样能再挑一次**。不给这个入口的话，"时长差 0.4 秒，可能不是同一个
        文件"就成了一句没有出路的警告——用户唯一的办法是退回首页重来一遍。
      */}
      <label className={`chip-btn file-pick${picked ? " again" : ""}`}>
        {busy ? "读取中…" : picked ? "换一个" : "指定文件…"}
        <input
          type="file"
          accept={accept}
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onPick(file);
            e.target.value = ""; // 允许对同一行再挑一次
          }}
        />
      </label>
    </div>
  );
}
