/**
 * 論理名の解決（P-05）。
 * 解決ロジックはこのファイルの関数以外に書かない（P 詳細設計 INV-1）。
 * ER図ノード・カタログ・詳細・検索のすべてがここを通る。
 */
import type { Dictionary, IndexTable, Table } from "./types";

export type NameSource = "meta" | "dictionary" | "physical";

export interface Resolved {
  name: string;
  source: NameSource;
}

/** 表示形式（併記が既定。L-02 / P-05） */
export type NameDisplay = "both" | "logical" | "physical";

/** テーブル論理名: meta.displayName → 物理名。空文字は未設定として扱う */
export function resolveTableName(physicalName: string, displayName: string | undefined): Resolved {
  if (displayName) return { name: displayName, source: "meta" };
  return { name: physicalName, source: "physical" };
}

export function resolveTableNameOf(t: Pick<Table, "name" | "meta">): Resolved {
  return resolveTableName(t.name, t.meta?.displayName);
}

export function resolveIndexTableName(t: Pick<IndexTable, "name" | "displayName">): Resolved {
  return resolveTableName(t.name, t.displayName);
}

/** カラム論理名: テーブル個別（meta.columns）→ 横断辞書 → 物理名 */
export function resolveColumnName(
  table: Pick<Table, "meta"> | null,
  column: string,
  dict: Dictionary | null,
): Resolved {
  const individual = table?.meta?.columns?.[column]?.displayName;
  if (individual) return { name: individual, source: "meta" };
  const fromDict = dict?.columns?.[column];
  if (fromDict) return { name: fromDict, source: "dictionary" };
  return { name: column, source: "physical" };
}

/**
 * 表示文字列の組み立て。
 * 併記: 論理名があれば「論理名 (物理名)」、なければ物理名のみ。
 */
export function formatName(resolved: Resolved, physicalName: string, mode: NameDisplay): string {
  if (mode === "physical" || resolved.source === "physical") return physicalName;
  if (mode === "logical") return resolved.name;
  return `${resolved.name} (${physicalName})`;
}
