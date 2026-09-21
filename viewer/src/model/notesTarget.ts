/**
 * 注記の直接編集（R-05）の対象。テーブル画面（詳細 / ドキュメント）のペンから
 * ダイアログを開き、確定＝即時保存（saveTableMeta）で 1 フィールドだけ書き換える。
 *
 * どれも `meta.*` の人が書く注記であり、保存の経路は同じ。対象ごとに違うのは
 * 「どこを読むか / どこへ書くか」だけなので、ここに閉じ込める。
 */
import type { MetaDraft } from "./metaDraft";
import type { Table } from "./types";

export type NotesTarget =
  /** テーブル注記（meta.notes） */
  | { kind: "table"; tableId: string }
  /** カラム注記（meta.columns[<column>].notes） */
  | { kind: "column"; tableId: string; column: string }
  /** 物理FK の多重度の補足（meta.relations["fk:<name>"].notes。物理FK 自体は machine-owned で注記を持てない） */
  | { kind: "physicalFk"; tableId: string; name: string }
  /** 論理外部制約の注記（meta.logicalForeignKeys[at].notes）。名前は保存時の食い違い検出に使う */
  | { kind: "logicalFk"; tableId: string; at: number; name?: string }
  /** 論理一意制約の注記（meta.logicalUniques[at].notes） */
  | { kind: "logicalUnique"; tableId: string; at: number; name?: string };

/** 今の注記（ダイアログの初期値） */
export function readNotes(table: Table, target: NotesTarget): string {
  switch (target.kind) {
    case "table":
      return table.meta?.notes ?? "";
    case "column":
      return table.meta?.columns?.[target.column]?.notes ?? "";
    case "physicalFk":
      return table.meta?.relations?.[`fk:${target.name}`]?.notes ?? "";
    case "logicalFk":
      return table.meta?.logicalForeignKeys?.[target.at]?.notes ?? "";
    case "logicalUnique":
      return table.meta?.logicalUniques?.[target.at]?.notes ?? "";
  }
}

/** ダイアログの見出しに出す対象の名前（テーブルは ID、カラム・制約は物理名） */
export function notesLabel(target: NotesTarget): string {
  switch (target.kind) {
    case "table":
      return target.tableId;
    case "column":
      return target.column;
    case "physicalFk":
      return target.name;
    case "logicalFk":
    case "logicalUnique":
      return target.name ?? `#${target.at + 1}`;
  }
}

/**
 * 読み直したドラフトの注記だけを差し替える。対象が見当たらない（他で消された・並びが変わった）
 * ときは null を返して保存を中止する（saveTableMeta が stale として扱う）。
 */
export function writeNotes(draft: MetaDraft, target: NotesTarget, text: string): MetaDraft | null {
  switch (target.kind) {
    case "table":
      return { ...draft, notes: text };
    case "column": {
      const cm = draft.columns[target.column];
      if (cm === undefined) return null;
      return { ...draft, columns: { ...draft.columns, [target.column]: { ...cm, notes: text } } };
    }
    case "physicalFk": {
      const c = draft.physicalCardinality[target.name];
      if (c === undefined) return null;
      return {
        ...draft,
        physicalCardinality: { ...draft.physicalCardinality, [target.name]: { ...c, notes: text } },
      };
    }
    case "logicalFk": {
      const fk = draft.logicalForeignKeys[target.at];
      if (fk === undefined || (target.name !== undefined && fk.name !== target.name)) return null;
      const next = [...draft.logicalForeignKeys];
      next[target.at] = { ...fk, notes: text };
      return { ...draft, logicalForeignKeys: next };
    }
    case "logicalUnique": {
      const u = draft.logicalUniques[target.at];
      if (u === undefined || (target.name !== undefined && u.name !== target.name)) return null;
      const next = [...draft.logicalUniques];
      next[target.at] = { ...u, notes: text };
      return { ...draft, logicalUniques: next };
    }
  }
}
