/**
 * 論理制約（論理外部制約 / 論理一意制約）の削除の対象（R-05）。
 *
 * 詳細ダイアログ（リレーション / 制約）と ER図のリレーション編集（E-11）から、
 * 確定＝即時保存（saveTableMeta）で 1 件だけ取り除く。対象ごとに違うのは
 * 「どれを消すか」の指し方だけなので、ここに閉じ込める。
 * 注記の書き換えは notesTarget.ts、テーブル / カラムの論理情報は metaTarget.ts。
 */
import type { MetaDraft } from "./metaDraft";

export type ConstraintTarget =
  /** 論理外部制約（meta.logicalForeignKeys）。エッジ ID から名前が決まるため名前で指す */
  | { kind: "logicalFk"; tableId: string; name: string }
  /** 論理一意制約（meta.logicalUniques）。名前を持たない制約もあるため位置で指す */
  | { kind: "logicalUnique"; tableId: string; at: number; name?: string };

/**
 * 読み直したドラフトから対象の制約を取り除く。対象が見当たらない（他で消された・
 * 並びが変わった）ときは null を返して保存を中止する（saveTableMeta が stale として扱う）。
 *
 * 論理外部制約のカーディナリティ（meta.relations["lfk:<名前>"]）はドラフトでは制約の行が
 * 持っているため、行を落とせば一緒に消える（孤児として残らない）。
 */
export function removeConstraint(draft: MetaDraft, target: ConstraintTarget): MetaDraft | null {
  if (target.kind === "logicalFk") {
    const rest = draft.logicalForeignKeys.filter((fk) => fk.name.trim() !== target.name);
    if (rest.length === draft.logicalForeignKeys.length) return null;
    return { ...draft, logicalForeignKeys: rest };
  }
  const u = draft.logicalUniques[target.at];
  if (u === undefined || (target.name !== undefined && u.name !== target.name)) return null;
  return { ...draft, logicalUniques: draft.logicalUniques.filter((_, i) => i !== target.at) };
}
