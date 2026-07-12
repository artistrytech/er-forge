/**
 * サーバーモードの書き込み API 呼び出し（§8.2）。
 * データの読み込みには使わない（読み込みは loader.ts の <script> 注入1本。§4.3）。
 * §2.3 によりビューア本体では fetch を使わないため XHR で実装する。
 */

export interface ApiResponse {
  status: number;
  body: string;
}

/** 起動 URL の ?t=<token>（§8.1）。API 呼び出しに引き回す */
export function apiToken(): string {
  return new URLSearchParams(location.search).get("t") ?? "";
}

export function apiPost(path: string, body: unknown): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${path}?t=${encodeURIComponent(apiToken())}`, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(JSON.stringify(body));
  });
}
