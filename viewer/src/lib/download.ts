/**
 * テキストをファイルとして保存させる（ツールメニューの書き出し）。
 *
 * Blob URL + `<a download>` で行う。静的モード（`file://`）でも使えることが要件なので、
 * サーバー・クリップボードのどちらにも依存しない経路にしている
 * （`file://` ではクリップボード API が塞がれていることがある。ExportDialog 参照）。
 */
export function downloadText(fileName: string, text: string, mime: string): void {
  downloadBlob(fileName, new Blob([text], { type: `${mime};charset=utf-8` }));
}

/** サーバーが作ったファイル（閲覧用 ZIP。A-11）をそのまま保存させる。 */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  // Firefox はドキュメントに繋がっていない要素のクリックを無視する
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke が早すぎるとダウンロードが始まらないブラウザがあるため次のタスクへ回す
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
