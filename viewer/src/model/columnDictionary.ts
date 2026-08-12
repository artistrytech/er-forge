/**
 * カラム辞書の画面（P-03）の行集合の計算。
 *
 * 行 = distinct(すべてのテーブルの columns[].name) ∪ 辞書のキー。
 * 辞書にあるがどのテーブルにも現れないキーは「孤立エントリ」として残す
 * （自動削除しない。P 詳細設計 §2.2）。
 */
import { normalizeTags, splitTagInput } from "./metaRules";
import type { Dictionary, Table } from "./types";

/** 辞書の1エントリの編集中の値（空文字 / 空配列 = 未設定）。 */
export interface DictionaryDraft {
  displayName: string;
  tags: string[];
  color: string;
}

export const EMPTY_DRAFT: DictionaryDraft = { displayName: "", tags: [], color: "" };

export function draftOf(dict: Dictionary | null, name: string): DictionaryDraft {
  const entry = dict?.columns?.[name];
  return {
    displayName: entry?.displayName ?? "",
    tags: [...(entry?.tags ?? [])],
    color: entry?.color ?? "",
  };
}

export function draftsOf(dict: Dictionary | null): Record<string, DictionaryDraft> {
  const out: Record<string, DictionaryDraft> = {};
  for (const name of Object.keys(dict?.columns ?? {})) {
    out[name] = draftOf(dict, name);
  }
  return out;
}

/** 全フィールドが空 = 「未設定」。保存時にキーごと落とす（P §1.1） */
export function isEmptyDraft(d: DictionaryDraft): boolean {
  return d.displayName.trim() === "" && d.tags.length === 0 && d.color === "";
}

/** テーブル個別（P-04 / P-12 / P-13）の設定1件。詳細ダイアログで一覧する */
export interface ColumnOverride {
  tableId: string;
  /** 個別の論理名（辞書を上書きする）。未設定なら undefined */
  displayName?: string;
  /** 個別の色（辞書を上書きする）。未設定なら undefined */
  color?: string;
  /** 個別のタグ（共通タグに追加される。共通タグは消せない） */
  tags: string[];
}

export interface ColumnRow {
  name: string;
  /** このカラム名を持つテーブル数 */
  occurrences: number;
  occurrenceTables: string[];
  /** 何らかの個別設定を持つテーブル（論理名 / 色 / タグ） */
  overrides: ColumnOverride[];
  /** うち論理名を個別に持つテーブルID（辞書の論理名が効かないテーブル） */
  nameOverrides: string[];
}

export function aggregateColumns(
  tables: readonly Table[],
  dict: Dictionary | null,
): ColumnRow[] {
  const rows = new Map<string, ColumnRow>();
  const row = (name: string): ColumnRow => {
    let r = rows.get(name);
    if (!r) {
      r = { name, occurrences: 0, occurrenceTables: [], overrides: [], nameOverrides: [] };
      rows.set(name, r);
    }
    return r;
  };

  for (const t of tables) {
    for (const c of t.columns) {
      const r = row(c.name);
      r.occurrences += 1;
      r.occurrenceTables.push(t.id);
    }
    for (const [col, cm] of Object.entries(t.meta?.columns ?? {})) {
      const displayName = cm.displayName !== undefined && cm.displayName !== "" ? cm.displayName : undefined;
      const color = cm.color !== undefined && cm.color !== "" ? cm.color : undefined;
      const tags = cm.tags ?? [];
      if (displayName === undefined && color === undefined && tags.length === 0) continue;
      const r = row(col);
      r.overrides.push({ tableId: t.id, displayName, color, tags: [...tags] });
      if (displayName !== undefined) r.nameOverrides.push(t.id);
    }
  }
  for (const name of Object.keys(dict?.columns ?? {})) {
    row(name);
  }

  // 物理名の昇順（アルファベット順）。出現数の降順にしていたが、数百行の一覧では
  // 「目当てのカラムがどこにあるか」を名前から見当を付けられることの方が効く
  // （出現数は見て分からないため、並びの理由が読めず探し直しになる）
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

/** 一括貼り付けの1行。列が無かった項目は undefined（据え置き）、空文字は「消す」 */
export interface PastedRow {
  name: string;
  displayName?: string;
  tags?: string[];
  color?: string;
}

/**
 * スプレッドシートからの一括貼り付け（P-03 §2.3）。
 * 「物理名 <TAB> 論理名 [<TAB> タグ [<TAB> 色]]」の行を解釈する。
 * タブが無い行・物理名が空の行は無視する。値の空は「削除」を意味するため保持する。
 * タグの区切りはタグ入力 UI と同じ（空白・`,`・`、`）。
 */
export function parseTsvRows(text: string): PastedRow[] {
  const out: PastedRow[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.indexOf("\t") < 0) continue;
    const cells = line.split("\t");
    const name = (cells[0] ?? "").trim();
    if (name === "") continue;
    const parsed: PastedRow = { name, displayName: (cells[1] ?? "").trim() };
    if (cells.length > 2) parsed.tags = splitTagInput(cells[2] ?? "");
    if (cells.length > 3) parsed.color = (cells[3] ?? "").trim();
    out.push(parsed);
  }
  return out;
}

/** 貼り付け1行を編集中の値へ適用する（列が無かった項目は据え置く） */
export function applyPastedRow(draft: DictionaryDraft, pasted: PastedRow): DictionaryDraft {
  return {
    displayName: pasted.displayName ?? draft.displayName,
    tags: pasted.tags === undefined ? draft.tags : normalizeTags(pasted.tags),
    color: pasted.color ?? draft.color,
  };
}
