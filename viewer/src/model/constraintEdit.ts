/**
 * 制約の「定義そのもの」を詳細ダイアログから書き換える（R-05）。
 *
 * 注記だけを差し替える `notesTarget.ts`、論理制約を取り除く `constraintTarget.ts` と
 * 同じ役割分担で、ここは**カーディナリティの上書き**（物理FK / 論理外部制約）と
 * **カラム対応 / 対象カラム**（論理外部制約 / 論理一意制約）を扱う。
 * どれも確定＝即時保存（`saveTableMeta`）で、読み直したドラフトの1か所だけを書き換える。
 *
 * 対象が見当たらない（他で消された・並びが変わった）ときは null を返して保存を中止する
 * （`saveTableMeta` が stale として扱う）。
 */
import type { DraftCardinality, MetaDraft } from "./metaDraft";

/** カーディナリティの書き先。物理FK（fk）・論理外部制約（lfk）とも制約名で指す */
export interface CardinalityTarget {
  kind: "fk" | "lfk";
  name: string;
}

export function writeCardinality(
  draft: MetaDraft,
  target: CardinalityTarget,
  value: DraftCardinality,
): MetaDraft | null {
  if (target.kind === "fk") {
    const current = draft.physicalCardinality[target.name];
    if (current === undefined) return null;
    // 多重度の補足（notes）は別の導線（インライン編集）で書くため、ここでは持ち越す
    return {
      ...draft,
      physicalCardinality: {
        ...draft.physicalCardinality,
        [target.name]: { ...value, notes: current.notes },
      },
    };
  }
  const at = draft.logicalForeignKeys.findIndex((fk) => fk.name.trim() === target.name);
  const fk = draft.logicalForeignKeys[at];
  if (fk === undefined) return null;
  const rows = [...draft.logicalForeignKeys];
  rows[at] = { ...fk, cardinality: { ...value, notes: fk.cardinality.notes } };
  return { ...draft, logicalForeignKeys: rows };
}

/**
 * 論理外部制約のカラム対応（自カラム → 参照先カラム）。参照先テーブルは変えない
 * （変えるとカーディナリティ・注記の前提ごと別の制約になるため、テーブル編集画面 / ER図で行う）。
 */
export function writeFkColumns(
  draft: MetaDraft,
  name: string,
  columns: string[],
  refColumns: string[],
): MetaDraft | null {
  const at = draft.logicalForeignKeys.findIndex((fk) => fk.name.trim() === name);
  const fk = draft.logicalForeignKeys[at];
  if (fk === undefined) return null;
  const rows = [...draft.logicalForeignKeys];
  rows[at] = { ...fk, columns, refColumns };
  return { ...draft, logicalForeignKeys: rows };
}

/** 論理一意制約の対象カラム。名前を持たない制約もあるため位置 + 名前の突き合わせで指す */
export function writeUniqueColumns(
  draft: MetaDraft,
  target: { at: number; name?: string },
  columns: string[],
): MetaDraft | null {
  const u = draft.logicalUniques[target.at];
  if (u === undefined || (target.name !== undefined && u.name !== target.name)) return null;
  const rows = [...draft.logicalUniques];
  rows[target.at] = { ...u, columns };
  return { ...draft, logicalUniques: rows };
}
