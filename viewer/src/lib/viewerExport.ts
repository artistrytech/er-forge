/**
 * 閲覧用 ZIP（A-11）のファイル名の規則と、同じ書き出しを行う CLI の文字列。
 *
 * **正はサーバー（`ViewerExport.prefixError`）である。** ここにあるのは入力中に即時で
 * 赤字を出すための写しで、通ってしまっても最終的にサーバーが 400 で弾く。
 * 規則を変えるときは Java 側と一緒に直すこと（java: server/src/main/java/erd/web/ViewerExport.java）。
 */

export const DEFAULT_EXPORT_PREFIX = "ERForge-viewer";

const PREFIX_MAX = 64;

/** どの OS でもファイル名に使えない文字（Windows が最も厳しいのでそれに合わせる）。 */
const FORBIDDEN = '\\/:*?"<>|';

/** Windows の予約デバイス名。拡張子を付けても予約のまま。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 弾いた理由（そのまま翻訳キー）。i18n のキーと一致していること。 */
export type ExportPrefixErrorKey =
  | "viewerExport.error.empty"
  | "viewerExport.error.tooLong"
  | "viewerExport.error.control"
  | "viewerExport.error.forbidden"
  | "viewerExport.error.edges"
  | "viewerExport.error.reserved";

/** 不正なら理由の翻訳キーを返す（正常なら null）。 */
export function exportPrefixError(prefix: string): ExportPrefixErrorKey | null {
  if (prefix === "") return "viewerExport.error.empty";
  if (prefix.length > PREFIX_MAX) return "viewerExport.error.tooLong";
  for (const ch of prefix) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return "viewerExport.error.control";
    if (FORBIDDEN.includes(ch)) return "viewerExport.error.forbidden";
  }
  if (prefix.startsWith(" ") || prefix.endsWith(" ") || prefix.endsWith(".")) {
    return "viewerExport.error.edges";
  }
  if (RESERVED.test(prefix)) return "viewerExport.error.reserved";
  return null;
}

/**
 * GUI と同じ書き出しを行うコマンド文字列（画面に提示してコピーさせる）。
 * 既定と同じ値になるオプションは付けない（`erd.bat export` の最短形を見せたいため）。
 */
export function exportCommand(options: {
  prefix: string;
  /** 選択中のワークスペース ID */
  workspaces: string[];
  /** 存在するワークスペースの総数。全選択ならワークスペース指定を省く */
  total: number;
  windows: boolean;
}): string {
  const { prefix, workspaces, total, windows } = options;
  const parts = [windows ? "erd.bat" : "./erd.sh", "export"];
  if (prefix !== DEFAULT_EXPORT_PREFIX) parts.push(`--prefix=${quote(prefix)}`);
  if (workspaces.length > 0 && workspaces.length < total) {
    parts.push(`--workspaces=${quote(workspaces.join(","))}`);
  }
  return parts.join(" ");
}

/** 空白などを含む値はそのまま貼れるように引用符で囲む（中の " は名前に使えないので考えない）。 */
function quote(value: string): string {
  return /^[A-Za-z0-9._,-]+$/.test(value) ? value : `"${value}"`;
}

/** ブラウザとサーバーは同じ機械で動く前提（127.0.0.1）なので、UA で起動スクリプトを選ぶ。 */
export function isWindows(): boolean {
  return /Windows/i.test(navigator.userAgent);
}
