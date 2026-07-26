/**
 * ワークスペース（マルチデータベース構成の単位）。
 *
 * 実体は `erd/workspace-<id>/data/**` で、一覧と表示名は `erd/workspaces.js`（ツール生成物）から読む。
 * 静的モード（file://）はディレクトリを走査できないため、プルダウンに出す一覧はこのファイルが唯一の情報源になる。
 *
 * **現在のワークスペースはモジュール変数で持つ。** 切り替えはフルリロード（URL 変更 + reload）で行うため、
 * 1度のページ寿命の中で変わらない。ローダー・ルーター・API がこの1点だけを見ればよい。
 */

export interface WorkspaceRef {
  id: string;
  name: string;
}

/** 英数で始まり、英数・ハイフン・アンダーバーのみ。32文字まで（サーバー側と同一の規則） */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export const DEFAULT_WORKSPACE_ID = "default";

export function isValidWorkspaceId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** 重複判定は大文字小文字を区別しない（Windows のパス仕様に合わせる） */
export function sameWorkspaceId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 新規作成時に提案する ID。既定は `default` で、既にあれば `default-2`, `default-3`… とずらす
 * （エラーにはせず、入力欄に埋めた状態で確定させる）。
 */
export function suggestWorkspaceId(existing: WorkspaceRef[]): string {
  const taken = new Set(existing.map((w) => w.id.toLowerCase()));
  if (!taken.has(DEFAULT_WORKSPACE_ID)) return DEFAULT_WORKSPACE_ID;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${DEFAULT_WORKSPACE_ID}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${DEFAULT_WORKSPACE_ID}-${Date.now()}`;
}

// ------------------------------------------------------- 現在のワークスペース

let currentId: string | null = null;

export function setCurrentWorkspaceId(id: string | null): void {
  currentId = id;
}

export function currentWorkspaceId(): string | null {
  return currentId;
}

/** データの読み込み基点（`<script src>` の相対パス）。サーバーモードでも同じ形で配信される */
export function dataBase(id: string | null = currentId): string {
  return `workspace-${id ?? DEFAULT_WORKSPACE_ID}/data/`;
}

/** ワークスペースに属する API のパス（`/__erd/w/<id>/...`） */
export function workspaceApi(path: string): string {
  return `/__erd/w/${encodeURIComponent(currentId ?? DEFAULT_WORKSPACE_ID)}${path}`;
}
