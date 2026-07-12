/**
 * 全体検索（F-01 / F-04）。
 * テーブル名・論理名・タグは index.js の範囲で常に検索でき、
 * カラム名・カラム論理名・コメントはロード済みのテーブルに対して段階的に拡張される。
 */
import { resolveColumnName, resolveIndexTableName } from "./logicalName";
import type { Dictionary, IndexData, Table } from "./types";

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
): TableHit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const hits: TableHit[] = [];

  for (const t of index.tables ?? []) {
    const resolved = resolveIndexTableName(t);
    let tableMatched =
      t.name.toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q) ||
      resolved.name.toLowerCase().includes(q) ||
      (t.tags ?? []).some((tag) => tag.toLowerCase().includes(q));

    const columnHits: ColumnHit[] = [];
    const full = tables[t.id];
    if (full) {
      if (!tableMatched && full.comment !== undefined && full.comment.toLowerCase().includes(q)) {
        tableMatched = true;
      }
      for (const c of full.columns) {
        const logical = resolveColumnName(full, c.name, dict);
        const notes = full.meta?.columns?.[c.name]?.notes;
        let matched: string | null = null;
        if (c.name.toLowerCase().includes(q)) matched = c.name;
        else if (logical.source !== "physical" && logical.name.toLowerCase().includes(q)) {
          matched = logical.name;
        } else if (c.comment !== undefined && c.comment.toLowerCase().includes(q)) {
          matched = c.comment;
        } else if (notes !== undefined && notes.toLowerCase().includes(q)) {
          matched = notes;
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
