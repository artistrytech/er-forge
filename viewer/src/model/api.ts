/**
 * サーバーモードの API 呼び出し（§8.2）。
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

export function apiRequest(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `${path}?t=${encodeURIComponent(apiToken())}`, true);
    if (body !== undefined) xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(body === undefined ? null : JSON.stringify(body));
  });
}

export const apiGet = (path: string) => apiRequest("GET", path);
export const apiPost = (path: string, body: unknown) => apiRequest("POST", path, body);
export const apiPut = (path: string, body: unknown) => apiRequest("PUT", path, body);
export const apiPatch = (path: string, body: unknown) => apiRequest("PATCH", path, body);
export const apiDelete = (path: string, body?: unknown) => apiRequest("DELETE", path, body);
