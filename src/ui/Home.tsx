/**
 * 首页：项目列表（M4 第 3 项，D37）。布局按 design/kerf-home-mockup.html 定稿实现。
 *
 * 三条来自设计稿的纪律：
 * - **卡片上没有任何"上次怎么了"的标记**——"上次崩没崩"没有判据（快照就是项目
 *   本体，每个项目都永远有快照），「3 分钟前」就是全部真相。
 * - **离线标记和封面是两个读数，各自惰性填**：离线由 `isReadable`（真读一个字节）判，
 *   "封面抽不出来"不构成离线的证据——那还可能是解码失败。全部项目 × 全部素材是
 *   N×M 次读，所以先渲染卡片、标记后到，不等它。
 * - **删项目只删快照不碰 assets**：「制作副本」让两个项目共享素材引用是刻意的。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectId, ProjectSummary } from "../state/project-snapshot";
import { UNNAMED_PROJECT } from "../state/project-snapshot";
import { formatDuration } from "../time/timebase";
import { formatFps } from "../time/rational";
import {
  IconCopy,
  IconDots,
  IconFilm,
  IconMark,
  IconPen,
  IconPlus,
  IconTrash,
  IconWarn,
} from "./icons";
import "./home.css";

/** 改动时间的口语化。只在首页用，精确时刻悬停 `title` 里有。 */
function relativeTime(savedAt: number, now: number): string {
  const diff = now - savedAt;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const then = new Date(savedAt);
  const today = new Date(now);
  const hm = `${String(then.getHours()).padStart(2, "0")}:${String(then.getMinutes()).padStart(2, "0")}`;
  if (then.toDateString() === today.toDateString()) return `今天 ${hm}`;
  if (then.toDateString() === new Date(now - 86_400_000).toDateString()) return `昨天 ${hm}`;
  const date = `${then.getMonth() + 1} 月 ${then.getDate()} 日`;
  return then.getFullYear() === today.getFullYear() ? date : `${then.getFullYear()} 年 ${date}`;
}

export function Home({
  onOpen,
  onCreate,
  onOpenSelfCheck,
}: {
  readonly onOpen: (id: ProjectId) => void;
  readonly onCreate: () => void;
  readonly onOpenSelfCheck: () => void;
}) {
  /** null = 还在问 IndexedDB。问出来是空列表才是"第一次打开"的空态。 */
  const [projects, setProjects] = useState<readonly ProjectSummary[] | null>(null);
  /** 每个项目读不动的素材数。**后到**——卡片先渲染，标记异步填（见文件头）。 */
  const [lost, setLost] = useState<Record<ProjectId, number>>({});
  const [posters, setPosters] = useState<Record<ProjectId, ImageBitmap | null>>({});
  const [menuFor, setMenuFor] = useState<ProjectId | null>(null);
  const [renamingId, setRenamingId] = useState<ProjectId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    let stale = false;
    void import("../state/project-store")
      .then(({ listProjects }) => listProjects())
      .then((list) => {
        if (!stale) setProjects(list);
      })
      .catch(() => {
        if (!stale) setProjects([]);
      });
    return () => {
      stale = true;
    };
  }, []);

  useEffect(refresh, [refresh]);

  // 离线标记与封面：卡片各自异步填。依赖异步状态的降级要靠 setState 触发重渲，
  // 不能读一个没人叫醒的缓存（D36 那条"看得见的降级不要依赖异步状态"的另一半）
  useEffect(() => {
    if (!projects) return;
    let stale = false;
    for (const project of projects) {
      if (project.sources.length > 0 && lost[project.id] === undefined) {
        void import("../state/project-store")
          .then(({ countUnreadableSources }) => countUnreadableSources(project.sources))
          .then((count) => {
            if (!stale) setLost((prev) => ({ ...prev, [project.id]: count }));
          })
          .catch(() => {});
      }
      if (project.poster && posters[project.id] === undefined) {
        void import("../media/poster")
          .then(({ loadPoster }) => loadPoster(project.id, project.poster!))
          .then((bitmap) => {
            if (!stale) setPosters((prev) => ({ ...prev, [project.id]: bitmap }));
          })
          .catch(() => {});
      }
    }
    return () => {
      stale = true;
    };
    // lost/posters 刻意不进依赖：它们的更新正是这个 effect 自己发起的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  // 最近的那张卡自动聚焦，「回车直接进」才成立
  const focusedOnce = useRef(false);
  const firstCard = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (projects && projects.length > 0 && !focusedOnce.current) {
      firstCard.current?.focus();
      focusedOnce.current = true;
    }
  }, [projects]);

  // 点菜单外面就收起
  useEffect(() => {
    if (menuFor === null) return;
    const close = () => setMenuFor(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuFor]);

  const remove = useCallback(
    async (project: ProjectSummary) => {
      const name = project.name ?? UNNAMED_PROJECT;
      // 删除给一次确认，写明片段数；没有回收站，删了就是删了（D37）
      if (!window.confirm(`删除「${name}」？${project.clipCount} 个片段会一起删除，删了就是删了。`)) {
        return;
      }
      const { deleteProject } = await import("../state/project-store");
      if (!(await deleteProject(project.id))) setError("删不掉，稍后再试");
      refresh();
    },
    [refresh],
  );

  const duplicate = useCallback(
    async (project: ProjectSummary) => {
      const { duplicateProject } = await import("../state/project-store");
      const copy = await duplicateProject(project.id);
      if (!copy) setError("制作副本失败");
      refresh();
    },
    [refresh],
  );

  const rename = useCallback(
    async (project: ProjectSummary, rawName: string) => {
      setRenamingId(null);
      const name = rawName.trim();
      // 空白名当取消，不当"清掉名字"——清掉会让下一次导入素材悄悄改名（见 operations.ts）
      if (name.length === 0 || name === (project.name ?? "")) return;
      const { renameStoredProject } = await import("../state/project-store");
      if (!(await renameStoredProject(project.id, name))) setError("重命名没存上");
      refresh();
    },
    [refresh],
  );

  return (
    <div className="hm">
      <div className="hm-top">
        <div className="brand">
          <IconMark className="mark" />
          <b>KERF</b>
        </div>
        <div className="spacer" />
        <button type="button" className="chip-btn" onClick={onOpenSelfCheck}>
          M0 自检
        </button>
        {projects !== null && projects.length > 0 && (
          <button type="button" className="btn-primary" onClick={onCreate}>
            <IconPlus />
            新建项目
          </button>
        )}
      </div>

      {error && (
        <div className="hm-note">
          <IconWarn />
          <span>{error}</span>
          <button type="button" className="chip-btn" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      )}

      <div className="hm-body">
        {projects === null ? null : projects.length === 0 ? (
          /* 没有项目时不画空网格：唯一能做的事就是新建，那它就该是画面里唯一的东西 */
          <div className="empty-home">
            <div className="big">还没有项目</div>
            <p className="lead">
              Kerf 在你的浏览器里剪片，导出也在本机完成——素材不会上传到任何地方。
              新建一个项目，然后导入视频、音频或图片。
            </p>
            <button type="button" className="btn-primary" onClick={onCreate}>
              <IconPlus />
              新建项目
            </button>
            <span className="hint">项目自动保存，不需要按保存</span>
          </div>
        ) : (
          <>
            <div className="hm-hd">
              <h2>项目</h2>
              <span className="count">{projects.length} 个</span>
            </div>
            <div className="grid">
              {projects.map((project, index) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  recent={index === 0}
                  cardRef={index === 0 ? firstCard : undefined}
                  poster={posters[project.id] ?? null}
                  lostCount={lost[project.id] ?? 0}
                  menuOpen={menuFor === project.id}
                  renaming={renamingId === project.id}
                  onOpen={() => onOpen(project.id)}
                  onMenu={(open) => setMenuFor(open ? project.id : null)}
                  onRenameStart={() => {
                    setMenuFor(null);
                    setRenamingId(project.id);
                  }}
                  onRenameCommit={(name) => void rename(project, name)}
                  onRenameCancel={() => setRenamingId(null)}
                  onDuplicate={() => {
                    setMenuFor(null);
                    void duplicate(project);
                  }}
                  onDelete={() => {
                    setMenuFor(null);
                    void remove(project);
                  }}
                />
              ))}
              <button type="button" className="card new" onClick={onCreate}>
                <IconPlus />
                <span>新建项目</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  recent,
  cardRef,
  poster,
  lostCount,
  menuOpen,
  renaming,
  onOpen,
  onMenu,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onDuplicate,
  onDelete,
}: {
  readonly project: ProjectSummary;
  readonly recent: boolean;
  readonly cardRef?: React.RefObject<HTMLDivElement | null> | undefined;
  readonly poster: ImageBitmap | null;
  readonly lostCount: number;
  readonly menuOpen: boolean;
  readonly renaming: boolean;
  readonly onOpen: () => void;
  readonly onMenu: (open: boolean) => void;
  readonly onRenameStart: () => void;
  readonly onRenameCommit: (name: string) => void;
  readonly onRenameCancel: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}) {
  const name = project.name ?? UNNAMED_PROJECT;
  return (
    <div
      ref={cardRef}
      className={`card${recent ? " recent" : ""}`}
      tabIndex={0}
      role="button"
      onClick={() => {
        if (!renaming) onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !renaming && e.target === e.currentTarget) onOpen();
      }}
    >
      <button
        type="button"
        className={`kebab${menuOpen ? " open" : ""}`}
        aria-label="更多"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(!menuOpen);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <IconDots />
      </button>
      {menuOpen && (
        <div className="menu" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" onClick={onRenameStart}>
            <IconPen />
            重命名
          </button>
          <button type="button" onClick={onDuplicate}>
            <IconCopy />
            制作副本
          </button>
          <hr />
          <button type="button" className="danger" onClick={onDelete}>
            <IconTrash />
            删除项目
          </button>
        </div>
      )}

      <div className={`shotarea${poster ? "" : " none"}`}>
        {poster ? <PosterFrame bitmap={poster} /> : <IconFilm />}
        {project.durationFrames > 0 && (
          <span className="dur">{formatDuration(project.durationFrames, project.fps)}</span>
        )}
      </div>

      <div className="meta">
        {renaming ? (
          <input
            className="rename"
            defaultValue={name}
            autoFocus
            spellCheck={false}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") onRenameCommit((e.target as HTMLInputElement).value);
              if (e.key === "Escape") onRenameCancel();
            }}
            onBlur={onRenameCancel}
          />
        ) : (
          <span className="nm">{name}</span>
        )}
        <span className="row">
          {project.width}×{project.height} · {formatFps(project.fps)} · {project.clipCount} 片段
        </span>
        <span className="row" title={new Date(project.savedAt).toLocaleString()}>
          {relativeTime(project.savedAt, Date.now())}
        </span>
        {lostCount > 0 && (
          <span className="flag lost">
            <IconWarn />
            {lostCount} 个素材找不到了
          </span>
        )}
      </div>
    </div>
  );
}

/** 封面位图画进 canvas；`object-fit: cover` 由 CSS 管，这里只按位图原尺寸画。 */
function PosterFrame({ bitmap }: { readonly bitmap: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  }, [bitmap]);
  return <canvas ref={ref} className="frame" />;
}
