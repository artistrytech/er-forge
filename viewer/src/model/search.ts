/**
 * 全体検索（F-01 / F-04）。
 * テーブル名・論理名・タグは index.js の範囲で常に検索でき、
 * カラム名・カラム論理名・コメントはロード済みのテーブルに対して段階的に拡張される。
 */
import { resolveColumnName, resolveColumnTags, resolveIndexTableName } from "./logicalName";
import type { Dictionary, IndexData, Table } from "./types";

/** 一致条件。router.ts の ColumnMatch と構造的に同一（層をまたぐ import を避けるため個別定義） */
export type MatchMode = "partial" | "prefix" | "suffix" | "exact";

/** haystack が needle に一致条件で当たるか（両者とも小文字化済みを渡す前提はない） */
export function matchText(haystack: string, needle: string, mode: MatchMode = "partial"): boolean {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (n === "") return true;
  switch (mode) {
    case "prefix":
      return h.startsWith(n);
    case "suffix":
      return h.endsWith(n);
    case "exact":
      return h === n;
    default:
      return h.includes(n);
  }
}

export interface ColumnHit {
  column: string;
  logicalName: string;
  /** マッチした内容（表示用）: カラム名 / 論理名 / コメント */
  matched: string;
}

export interface TableHit {
  tableId: string;
  /** テーブル自体（名前・論理名・タグ・コメント）がマッチしたか */
  tableMatched: boolean;
  columnHits: ColumnHit[];
}

export function searchAll(
  query: string,
  index: IndexData,
  tables: Record<string, Table>,
  dict: Dictionary | null,
  limit = 50,
  mode: MatchMode = "partial",
): TableHit[] {
  const q = query.trim();
  if (q === "") return [];
  const hit = (value: string | undefined): boolean =>
    value !== undefined && matchText(value, q, mode);
  const hits: TableHit[] = [];

  for (const t of index.tables ?? []) {
    const resolved = resolveIndexTableName(t);
    let tableMatched =
      hit(t.name) ||
      hit(t.id) ||
      hit(resolved.name) ||
      (t.tags ?? []).some((tag) => matchText(tag, q, mode));

    const columnHits: ColumnHit[] = [];
    const full = tables[t.id];
    if (full) {
      if (!tableMatched && hit(full.comment)) {
        tableMatched = true;
      }
      for (const c of full.columns) {
        const logical = resolveColumnName(full, c.name, dict);
        const cm = full.meta?.columns?.[c.name];
        const notes = cm?.notes;
        // カラムタグ（P-12）は index.js に載らないため、ロード済みのテーブルでのみ当たる（F-04）。
        // 共通タグ（カラム辞書）は全テーブルに効くが、ここでも「ロード済みのテーブルの
        // カラムヒット」として扱う。索引だけで判定すると1タグで全テーブルが並んでしまう
        const tagHit = resolveColumnTags(full, c.name, dict).tags.find((tag) =>
          matchText(tag, q, mode),
        );
        let matched: string | null = null;
        if (hit(c.name)) matched = c.name;
        else if (logical.source !== "physical" && hit(logical.name)) {
          matched = logical.name;
        } else if (hit(c.comment)) {
          matched = c.comment ?? null;
        } else if (hit(notes)) {
          matched = notes ?? null;
        } else if (tagHit !== undefined) {
          matched = tagHit;
        }
        if (matched !== null) {
          columnHits.push({ column: c.name, logicalName: logical.name, matched });
        }
      }
    }

    if (tableMatched || columnHits.length > 0) {
      hits.push({ tableId: t.id, tableMatched, columnHits });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}
