/** 内联图标。刻意不引图标库：数量少，且省掉一个依赖和运行时。 */

type IconProps = { readonly className?: string };

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconMark = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 15 19" aria-hidden="true">
    <path d="M3 0v19M12 0v19" stroke="currentColor" strokeWidth={2.4} />
    <path d="M6.6 3.5l1.8 12" stroke="currentColor" strokeWidth={1.1} opacity={0.55} />
  </svg>
);

export const IconUndo = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M3 7h7.5a3.5 3.5 0 010 7H7" />
    <path d="M6 4L3 7l3 3" />
  </svg>
);

export const IconRedo = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M13 7H5.5a3.5 3.5 0 000 7H9" />
    <path d="M10 4l3 3-3 3" />
  </svg>
);

export const IconPlay = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4.5 3l8 5-8 5z" fill="currentColor" />
  </svg>
);

export const IconPause = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" fill="currentColor" />
  </svg>
);

export const IconPrev = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M11 3v10L4 8z" fill="currentColor" />
    <path d="M3 3v10" stroke="currentColor" strokeWidth={1.4} />
  </svg>
);

export const IconNext = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5 3v10l7-5z" fill="currentColor" />
    <path d="M13 3v10" stroke="currentColor" strokeWidth={1.4} />
  </svg>
);

export const IconEye = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.3}>
    <path d="M1.5 8S4 4 8 4s6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="1.7" />
  </svg>
);

export const IconVolume = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.3}>
    <path d="M8 3L4.8 5.8H2.5v4.4h2.3L8 13z" />
    <path d="M10.6 6a3 3 0 010 4" />
  </svg>
);

export const IconMute = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.3}>
    <path d="M8 3L4.8 5.8H2.5v4.4h2.3L8 13z" />
    <path d="M10.5 6.5l3 3M13.5 6.5l-3 3" />
  </svg>
);

export const IconLock = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.3}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
    <path d="M5.6 7V5.2a2.4 2.4 0 014.8 0V7" />
  </svg>
);

export const IconMagnet = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M4 3v5a4 4 0 008 0V3" />
    <path d="M4 6.4h3.6M8.4 6.4H12" />
  </svg>
);

export const IconCut = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.3}>
    <circle cx="4.2" cy="12" r="1.9" />
    <circle cx="11.8" cy="12" r="1.9" />
    <path d="M5.4 10.6L11 2.5M10.6 10.6L5 2.5" />
  </svg>
);

export const IconTrash = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.3}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5" />
    <path d="M4.3 4.5l.7 8.2h6l.7-8.2" />
  </svg>
);

export const IconPlus = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.5}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

export const IconFilm = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.2}>
    <rect x="2" y="3.5" width="12" height="9" rx="1" />
    <path d="M5 3.5v9M11 3.5v9" />
  </svg>
);

export const IconWave = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.2}>
    <path d="M2.5 6.5v3M5.2 4.5v7M8 3v10M10.8 5v6M13.5 6.5v3" />
  </svg>
);

export const IconText = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.4}>
    <path d="M3.5 4h9M8 4v8.5" />
  </svg>
);

export const IconDownload = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.5}>
    <path d="M8 2.5v8M4.6 7.2L8 10.5l3.4-3.3M2.8 13.2h10.4" />
  </svg>
);

export const IconCheck = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={2}>
    <path d="M3 8.5l3.5 3.5L13 4.5" />
  </svg>
);

export const IconNo = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.8}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </svg>
);

export const IconX = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export const IconFolder = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M2 4.5A1.5 1.5 0 013.5 3h2.7l1.4 1.8h4.9A1.5 1.5 0 0114 6.3V12a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12z" />
  </svg>
);

export const IconWarn = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M8 2.2l6 11.3H2z" />
    <path d="M8 6.4v3.2M8 11.6h.01" />
  </svg>
);
