/**
 * ER図の視点（拡大率・表示位置）をページごとに覚える。
 *
 * テーブル詳細を見て ER図へ戻る、ページを行き来する、といった往復のたびに全体表示へ
 * 戻ってしまうと、拡大して読んでいた場所を毎回探し直すことになる。**最後に見ていた
 * ところから続けられる**ようにする。
 *
 * 置き場所は sessionStorage（**タブ単位**）。「最後に閲覧したページ / テーブル」と同じ扱いで、
 * リロードでは残り、別タブ・タブを閉じた後には引き継がない。ファイル（diagrams/<id>.js）には
 * 書かない — 視点は**見ている人の一時的な状態**であって、共有される図の内容ではない。
 *
 * ページはワークスペースごとに別物なので、キーにワークスペース ID を含める（store.ts と同じ）。
 */
import { useAppStore } from "../model/store";

/** React Flow の viewport。x / y は「flow 座標をどれだけずらして描くか」（px） */
export interface StoredViewport {
  x: number;
  y: number;
  zoom: number;
}

const KEY = "erd-viewport";

function storageKey(): string {
  const workspaceId = useAppStore.getState().workspaceId;
  return workspaceId === null ? KEY : `${KEY}:${workspaceId}`;
}

/** ページID → 視点。壊れていたら丸ごと捨てる（視点は失っても作り直せる） */
function readAll(): Record<string, StoredViewport> {
  try {
    const raw = sessionStorage.getItem(storageKey());
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, StoredViewport>;
  } catch {
    return {};
  }
}

/** 値の妥当性は読む側で見る（他タブ・古い版が書いた値、手で書き換えられた値もありうる） */
function isViewport(v: unknown): v is StoredViewport {
  if (typeof v !== "object" || v === null) return false;
  const { x, y, zoom } = v as Record<string, unknown>;
  return (
    typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y) &&
    // zoom は ErdPage の minZoom / maxZoom の範囲。外れた値で復元すると操作不能になる
    typeof zoom === "number" &&
    Number.isFinite(zoom) &&
    zoom > 0
  );
}

export function readViewport(diagramId: string): StoredViewport | null {
  const v: unknown = readAll()[diagramId];
  return isViewport(v) ? { x: v.x, y: v.y, zoom: v.zoom } : null;
}

export function saveViewport(diagramId: string, viewport: StoredViewport): void {
  if (!isViewport(viewport)) return;
  const all = readAll();
  all[diagramId] = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify(all));
  } catch {
    // sessionStorage が使えなくても致命的ではない（復元されないだけ）
  }
}
