/**
 * 論理名・色・タグの解決（P-05 / P-12 / P-13）。
 * 解決ロジックはこのファイルの関数以外に書かない（P 詳細設計 INV-1）。
 * ER図ノード・カタログ・詳細・検索のすべてがここを通る。
 *
 * カラムは「テーブル個別（meta.columns）」と「横断辞書（dictionary）」の2箇所で設定され、
 * **属性ごとに合わせ方が違う**。
 *
 * | 属性 | 規則 |
 * |---|---|
 * | 論理名 | 個別 → 辞書 → 物理名（上書き） |
 * | 色 | 個別 → 辞書（上書き） |
 * | タグ | 辞書 ∪ 個別（合成）。**共通タグは個別からは取り消せない** |
 *
 * タグだけ合成なのは、共通タグが「同名カラムはプロジェクト全体で同じ意味を持つ」という
 * 分類であり、テーブル1件の都合で消えると分類として使えなくなるため。
 */
import { normalizeTags } from "./metaRules";
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

type TableLike = Pick<Table, "meta"> | null;

/** カラム論理名: テーブル個別（meta.columns）→ カラム辞書 → 物理名 */
export function resolveColumnName(
  table: TableLike,
  column: string,
  dict: Dictionary | null,
): Resolved {
  const individual = table?.meta?.columns?.[column]?.displayName;
  if (individual) return { name: individual, source: "meta" };
  const fromDict = dict?.columns?.[column]?.displayName;
  if (fromDict) return { name: fromDict, source: "dictionary" };
  return { name: column, source: "physical" };
}

export interface ResolvedColor {
  /** 未設定は undefined（既定の外観） */
  color: string | undefined;
  source: "meta" | "dictionary" | "none";
}

/** カラムの色: テーブル個別 → 横断辞書。論理名と同じく個別が上書きする */
export function resolveColumnColor(
  table: TableLike,
  column: string,
  dict: Dictionary | null,
): ResolvedColor {
  const individual = table?.meta?.columns?.[column]?.color;
  if (individual) return { color: individual, source: "meta" };
  const fromDict = dict?.columns?.[column]?.color;
  if (fromDict) return { color: fromDict, source: "dictionary" };
  return { color: undefined, source: "none" };
}

export interface ResolvedTags {
  /** 表示用の合成結果（辞書 → 個別 の順。重複は先勝ちで除く） */
  tags: string[];
  /** そのうち辞書由来のもの（編集画面で readonly として出す） */
  dictionary: string[];
}

/**
 * カラムのタグ: 辞書 ∪ 個別。個別に同じタグを持っていても表示は1つにまとめる
 * （データ上の重複は許す。辞書からタグを外したときに個別が残るのは正しい挙動）。
 */
export function resolveColumnTags(
  table: TableLike,
  column: string,
  dict: Dictionary | null,
): ResolvedTags {
  const fromDict = dict?.columns?.[column]?.tags ?? [];
  const individual = table?.meta?.columns?.[column]?.tags ?? [];
  return {
    tags: normalizeTags([...fromDict, ...individual]),
    dictionary: normalizeTags(fromDict),
  };
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
