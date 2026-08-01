/**
 * テキストをファイルとして保存させる（ツールメニューの書き出し）。
 *
 * Blob URL + `<a download>` で行う。静的モード（`file://`）でも使えることが要件なので、
 * サーバー・クリップボードのどちらにも依存しない経路にしている
 * （`file://` ではクリップボード API が塞がれていることがある。ExportDialog 参照）。
 */
export function downloadText(fileName: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
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
