/**
 * リレーション・制約の注記のその場編集（R-05）の対象。詳細ダイアログ（リレーション / 制約）の
 * 中でインライン編集し、確定＝即時保存（saveTableMeta）で 1 フィールドだけ書き換える。
 *
 * どれも `meta.*` の人が書く注記であり、保存の経路は同じ。対象ごとに違うのは
 * 「どこへ書くか」だけなので、ここに閉じ込める。
 * テーブル / カラムの論理情報（論理名・タグ・色・注記）は metaTarget.ts。
 */
import type { MetaDraft } from "./metaDraft";

export type NotesTarget =
  /** 物理FK の多重度の補足（meta.relations["fk:<name>"].notes。物理FK 自体は machine-owned で注記を持てない） */
  | { kind: "physicalFk"; tableId: string; name: string }
  /** 論理外部制約の注記（meta.logicalForeignKeys[at].notes）。名前は保存時の食い違い検出に使う */
  | { kind: "logicalFk"; tableId: string; at: number; name?: string }
  /** 論理外部制約の多重度の補足（meta.relations["lfk:<name>"].notes。ドラフトでは制約の行が持つ） */
  | { kind: "logicalFkCardinality"; tableId: string; name: string }
  /** 論理一意制約の注記（meta.logicalUniques[at].notes） */
  | { kind: "logicalUnique"; tableId: string; at: number; name?: string };

/**
 * 読み直したドラフトの注記だけを差し替える。対象が見当たらない（他で消された・並びが変わった）
 * ときは null を返して保存を中止する（saveTableMeta が stale として扱う）。
 */
export function writeNotes(draft: MetaDraft, target: NotesTarget, text: string): MetaDraft | null {
  switch (target.kind) {
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
    case "logicalFkCardinality": {
      const at = draft.logicalForeignKeys.findIndex((fk) => fk.name === target.name);
      const fk = draft.logicalForeignKeys[at];
      if (fk === undefined) return null;
      const next = [...draft.logicalForeignKeys];
      next[at] = { ...fk, cardinality: { ...fk.cardinality, notes: text } };
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
