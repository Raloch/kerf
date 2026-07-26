/**
 * `showSaveFilePicker()` 的类型声明。
 *
 * TypeScript 的 lib.dom 已经有 `FileSystemFileHandle` / `FileSystemWritableFileStream`，
 * 但截至 TS 5.9 仍没有 picker 系列（它们在 WICG 规范里，未进 WHATWG HTML）。
 * 只声明我们实际用到的那一小块，不引第三方 @types 包。
 *
 * 声明成 `| undefined` 是刻意的：Safari 与 Firefox 没有这个 API，
 * 类型上就强制调用处先判存在，避免写出只在 Chrome 能跑的导出路径。
 */

interface SaveFilePickerType {
  readonly description?: string;
  readonly accept: Record<string, readonly string[]>;
}

interface SaveFilePickerOptions {
  readonly suggestedName?: string;
  readonly types?: readonly SaveFilePickerType[];
  readonly excludeAcceptAllOption?: boolean;
}

declare var showSaveFilePicker:
  | ((options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>)
  | undefined;
