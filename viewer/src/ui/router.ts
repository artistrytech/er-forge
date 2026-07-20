/**
 * ハッシュルーティング（設計書 §4.4 / B-07）。
 * file:// では History API が使えないため、URL は # ハッシュで表現する。
 */
import { useSyncExternalStore } from "react";

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

/** ルート → ハッシュ URL（リンク生成はすべてここを通す） */
export const hrefs = {
  erdHome: (): string => "#/erd",
  erd: (diagramId: string, tableId?: string): string =>
    tableId !== undefined
      ? `#/erd/${encodeURIComponent(diagramId)}/${encodeURIComponent(tableId)}`
      : `#/erd/${encodeURIComponent(diagramId)}`,
  erdEdit: (diagramId: string): string => `#/erd/${encodeURIComponent(diagramId)}/edit`,
  tables: (): string => "#/tables",
  table: (tableId: string): string => `#/tables/${encodeURIComponent(tableId)}`,
  tableEdit: (tableId: string): string => `#/tables/${encodeURIComponent(tableId)}/edit`,
  columns: (focusColumn?: string, focusMatch: ColumnMatch = "exact"): string =>
    focusColumn !== undefined
      ? `#/columns/focus/${encodeURIComponent(focusColumn)}/${focusMatch}`
      : "#/columns",
  columnsEdit: (): string => "#/columns/edit",
  introspect: (): string => "#/introspect",
};

export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "" || raw === "/") return { kind: "home" };
  const segments = raw
    .split("/")
    .filter((s) => s !== "")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

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
  return { kind: "notFound", path: raw };
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
