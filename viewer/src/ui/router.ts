/**
 * ハッシュルーティング（設計書 §4.4 / B-07）。
 * file:// では History API が使えないため、URL は # ハッシュで表現する。
 *
 * すべてのルートは `#/w/<workspaceId>/…` で始まる。**別のワークスペースの ER図 URL を
 * そのまま人に送れる**ようにするためで、マルチデータベース構成では「どの DB の図か」が
 * URL に入っていないと共有が成立しない。ワークスペース部を省いた URL（`#/erd/…`）も
 * 解釈でき、その場合はローダーが現在のワークスペースを補って書き換える。
 */
import { useSyncExternalStore } from "react";
import { currentWorkspaceId, isValidWorkspaceId } from "../model/workspace";

/** カラム論理名画面の一致条件（回答A）。検索モーダルからの遷移は exact を埋め込む */
export type ColumnMatch = "partial" | "prefix" | "suffix" | "exact";

export type Route =
  | { kind: "home" }
  /** ページ未指定の ER図。ページがあれば先頭へ転送し、無ければ作成の導線を出す（I-01） */
  | { kind: "erdHome" }
  | { kind: "erd"; diagramId: string; tableId?: string }
  /** ER図の配置編集（閲覧ルートから [編集開始] で遷移。§4.4 / H-10） */
  | { kind: "erdEdit"; diagramId: string }
  | { kind: "tables" }
  | { kind: "table"; tableId: string }
  | { kind: "tableEdit"; tableId: string }
  /** 閲覧。検索モーダルからの遷移時は focusColumn（物理名）＋ focusMatch で絞り込む */
  | { kind: "columns"; focusColumn?: string; focusMatch?: ColumnMatch }
  /** カラム論理名の一括編集（閲覧ルートから [編集開始] で遷移。P-03） */
  | { kind: "columnsEdit" }
  | { kind: "introspect" }
  | { kind: "notFound"; path: string };

/** 現在のワークスペースを表す URL 接頭辞（`#/w/<id>`） */
function base(): string {
  const ws = currentWorkspaceId();
  return ws === null ? "#" : `#/w/${encodeURIComponent(ws)}`;
}

/** ルート → ハッシュ URL（リンク生成はすべてここを通す） */
export const hrefs = {
  workspace: (workspaceId: string): string => `#/w/${encodeURIComponent(workspaceId)}/erd`,
  erdHome: (): string => `${base()}/erd`,
  erd: (diagramId: string, tableId?: string): string =>
    tableId !== undefined
      ? `${base()}/erd/${encodeURIComponent(diagramId)}/${encodeURIComponent(tableId)}`
      : `${base()}/erd/${encodeURIComponent(diagramId)}`,
  erdEdit: (diagramId: string): string => `${base()}/erd/${encodeURIComponent(diagramId)}/edit`,
  tables: (): string => `${base()}/tables`,
  table: (tableId: string): string => `${base()}/tables/${encodeURIComponent(tableId)}`,
  tableEdit: (tableId: string): string => `${base()}/tables/${encodeURIComponent(tableId)}/edit`,
  columns: (focusColumn?: string, focusMatch: ColumnMatch = "exact"): string =>
    focusColumn !== undefined
      ? `${base()}/columns/focus/${encodeURIComponent(focusColumn)}/${focusMatch}`
      : `${base()}/columns`,
  columnsEdit: (): string => `${base()}/columns/edit`,
  introspect: (): string => `${base()}/introspect`,
};

/** URL が指しているワークスペース（`#/w/<id>/…`）。無ければ null */
export function workspaceIdFromHash(hash: string): string | null {
  const segments = hashSegments(hash);
  if (segments[0] === "w" && segments[1] !== undefined && isValidWorkspaceId(segments[1])) {
    return segments[1];
  }
  return null;
}

function hashSegments(hash: string): string[] {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return raw
    .split("/")
    .filter((s) => s !== "")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

export function parseHash(hash: string): Route {
  let segments = hashSegments(hash);
  // ワークスペース部は解釈の前に落とす（画面のルートはワークスペースに依存しない）
  if (segments[0] === "w" && segments[1] !== undefined) {
    segments = segments.slice(2);
  }
  if (segments.length === 0) return { kind: "home" };

  const [head, a, b] = segments;
  if (head === "erd") {
    if (segments.length === 1) return { kind: "erdHome" };
    if (a !== undefined) {
      if (segments.length === 2) return { kind: "erd", diagramId: a };
      if (segments.length === 3 && b === "edit") return { kind: "erdEdit", diagramId: a };
      if (segments.length === 3 && b !== undefined) return { kind: "erd", diagramId: a, tableId: b };
    }
  }
  if (head === "tables") {
    if (segments.length === 1) return { kind: "tables" };
    if (segments.length === 2 && a !== undefined) return { kind: "table", tableId: a };
    if (segments.length === 3 && a !== undefined && b === "edit") {
      return { kind: "tableEdit", tableId: a };
    }
  }
  if (head === "columns") {
    if (segments.length === 1) return { kind: "columns" };
    if (segments.length === 2 && a === "edit") return { kind: "columnsEdit" };
    // #/columns/focus/<物理名>/<一致条件>（検索モーダルからの絞り込み遷移。回答A）
    if (segments.length === 4 && a === "focus" && b !== undefined) {
      const match = segments[3];
      const focusMatch = (["partial", "prefix", "suffix", "exact"] as const).find(
        (m) => m === match,
      );
      return { kind: "columns", focusColumn: b, focusMatch: focusMatch ?? "exact" };
    }
  }
  if (head === "introspect" && segments.length === 1) return { kind: "introspect" };
  // 表示用のパスはワークスペース部を落とした残り（`#/w/<id>` は画面の種類に関係しない）
  return { kind: "notFound", path: `/${segments.join("/")}` };
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

function getHash(): string {
  return location.hash;
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash);
  return parseHash(hash);
}

/** 履歴を汚さない遷移（リダイレクト用） */
export function replaceRoute(href: string): void {
  location.replace(href);
}
