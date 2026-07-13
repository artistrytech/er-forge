/**
 * カラム論理名の一括編集画面（P-03）の行集合の計算。
 *
 * 行 = distinct(すべてのテーブルの columns[].name) ∪ 辞書のキー。
 * 辞書にあるがどのテーブルにも現れないキーは「孤立エントリ」として残す
 * （自動削除しない。P 詳細設計 §2.2）。
 */
import type { Table } from "./types";

export interface ColumnRow {
  name: string;
  /** このカラム名を持つテーブル数 */
  occurrences: number;
  occurrenceTables: string[];
  /** テーブル個別の論理名（P-04）で辞書を上書きしているテーブルID */
  overrides: string[];
}

export function aggregateColumns(
  tables: readonly Table[],
  dictColumns: Readonly<Record<string, string>>,
): ColumnRow[] {
  const rows = new Map<string, ColumnRow>();
  const row = (name: string): ColumnRow => {
    let r = rows.get(name);
    if (!r) {
      r = { name, occurrences: 0, occurrenceTables: [], overrides: [] };
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
      if (cm.displayName !== undefined && cm.displayName !== "") {
        row(col).overrides.push(t.id);
      }
    }
  }
  for (const name of Object.keys(dictColumns)) {
    row(name);
  }

  // 出現数の降順（影響の大きいものから整備できる）→ 名前の昇順
  return [...rows.values()].sort(
    (a, b) => b.occurrences - a.occurrences || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/**
 * スプレッドシートからの一括貼り付け（P-03 §2.3）。
 * 「物理名<TAB>論理名」の行を [物理名, 論理名] の組に変換する。
 * タブが無い行・物理名が空の行は無視する。論理名の空は「削除」を意味するため保持する。
 */
export function parseTsvPairs(text: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name = line.slice(0, tab).trim();
    const value = line.slice(tab + 1).trim();
    if (name === "") continue;
    pairs.push([name, value]);
  }
  return pairs;
}
