/**
 * ハッシュルーティング（設計書 §4.4 / B-07）。
 * file:// では History API が使えないため、URL は # ハッシュで表現する。
 */
import { useSyncExternalStore } from "react";

export type Route =
  | { kind: "home" }
  | { kind: "erd"; diagramId: string; tableId?: string }
  | { kind: "tables" }
  | { kind: "table"; tableId: string }
  | { kind: "tableEdit"; tableId: string }
  | { kind: "columns" }
  | { kind: "notFound"; path: string };

/** ルート → ハッシュ URL（リンク生成はすべてここを通す） */
export const hrefs = {
  erd: (diagramId: string, tableId?: string): string =>
    tableId !== undefined
      ? `#/erd/${encodeURIComponent(diagramId)}/${encodeURIComponent(tableId)}`
      : `#/erd/${encodeURIComponent(diagramId)}`,
  tables: (): string => "#/tables",
  table: (tableId: string): string => `#/tables/${encodeURIComponent(tableId)}`,
  tableEdit: (tableId: string): string => `#/tables/${encodeURIComponent(tableId)}/edit`,
  columns: (): string => "#/columns",
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
  if (head === "erd" && a !== undefined) {
    if (segments.length === 2) return { kind: "erd", diagramId: a };
    if (segments.length === 3 && b !== undefined) return { kind: "erd", diagramId: a, tableId: b };
  }
  if (head === "tables") {
    if (segments.length === 1) return { kind: "tables" };
    if (segments.length === 2 && a !== undefined) return { kind: "table", tableId: a };
    if (segments.length === 3 && a !== undefined && b === "edit") {
      return { kind: "tableEdit", tableId: a };
    }
  }
  if (head === "columns" && segments.length === 1) return { kind: "columns" };
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
