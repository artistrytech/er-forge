/**
 * サーバーモードの API 呼び出し（§8.2）。
 * データの読み込みには使わない（読み込みは loader.ts の <script> 注入1本。§4.3）。
 * §2.3 によりビューア本体では fetch を使わないため XHR で実装する。
 */

export interface ApiResponse {
  status: number;
  body: string;
}

/**
 * ワークスペースに属する API のパス（`/__erd/w/<id>/...`）。
 * データを触る API はすべてこれを通す。属さないのは疎通確認・ワークスペース管理・
 * ドライバ設定（全ワークスペース共通）・SSE・自動レイアウトだけ。
 */
export { workspaceApi as wpath } from "./workspace";

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

/** バイナリを受け取る POST（閲覧用 ZIP の書き出し。A-11）。 */
export interface ApiBlobResponse {
  status: number;
  blob: Blob;
  /** Content-Disposition の filename*（サーバーが決めた名前。日本語も通る） */
  fileName: string;
}

export function apiPostBlob(path: string, body: unknown): Promise<ApiBlobResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${path}?t=${encodeURIComponent(apiToken())}`, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.responseType = "blob";
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        blob: xhr.response as Blob,
        fileName: fileNameOf(xhr.getResponseHeader("Content-Disposition")),
      });
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(JSON.stringify(body));
  });
}

/** RFC 5987 の `filename*=UTF-8''...` を優先し、無ければ `filename="..."` を使う。 */
function fileNameOf(disposition: string | null): string {
  if (disposition === null) return "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // 壊れていたら plain 側へ落ちる
    }
  }
  return /filename="([^"]*)"/i.exec(disposition)?.[1] ?? "";
}

export const apiGet = (path: string) => apiRequest("GET", path);
export const apiPost = (path: string, body: unknown) => apiRequest("POST", path, body);
export const apiPut = (path: string, body: unknown) => apiRequest("PUT", path, body);
export const apiPatch = (path: string, body: unknown) => apiRequest("PATCH", path, body);
export const apiDelete = (path: string, body?: unknown) => apiRequest("DELETE", path, body);
