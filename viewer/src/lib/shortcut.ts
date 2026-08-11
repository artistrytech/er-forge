/**
 * ショートカットのキー判定と表記をプラットフォームで切り替える。
 *
 * 判定は UA だけで完結するので、サーバーの無い静的モード（file://）でも同じように働く。
 */

/** Mac / iPad（iPadOS は "Macintosh" を名乗る）かどうか。 */
export function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** Cmd（Mac）または Ctrl（その他）が押されているか。 */
function hasModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

/** N-03: Undo。Mac の Redo が Shift 付きなので、Shift 無しだけを Undo とする。 */
export function isUndoKey(e: KeyboardEvent): boolean {
  return hasModifier(e) && !e.shiftKey && e.key.toLowerCase() === "z";
}

/**
 * N-03: Redo。両方の慣習を受け付ける。
 * - `Shift + Z`: Mac の標準。Windows でも通じるアプリが多い
 * - `Y`: Windows / Linux の標準。Mac の Cmd+Y はブラウザ既定（履歴など）に譲って割り当てない
 */
export function isRedoKey(e: KeyboardEvent): boolean {
  if (!hasModifier(e)) return false;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey;
  return key === "y" && !isApplePlatform();
}

/** ボタンの title に出す表記（その環境で一般的な方だけを見せる）。 */
export function undoHint(): string {
  return isApplePlatform() ? "⌘Z" : "Ctrl+Z";
}

export function redoHint(): string {
  return isApplePlatform() ? "⇧⌘Z" : "Ctrl+Y";
}
