/**
 * テーブル / カラムの論理情報（論理名・タグ・色・注記）のその場編集（R-05）の対象。
 *
 * テーブル画面（詳細 / ドキュメント）と ER図のテーブル詳細ダイアログのペンから
 * 論理情報ダイアログ（MetaEditDialog）を開き、確定＝即時保存（saveTableMeta）で
 * その1件分の項目だけを書き換える。テーブル編集画面（O-03）と同じ項目・同じ規則で、
 * 空文字は「未設定」= キー削除になる（draftToMeta の既存規則）。
 *
 * リレーション・制約の注記は notesTarget.ts（対象が違うだけで保存の経路は同じ）。
 */
import type { MetaDraft } from "./metaDraft";
import type { Table } from "./types";

export type MetaTarget =
  /** テーブル（meta.displayName / tags / color / notes） */
  | { kind: "table"; tableId: string }
  /** カラム（meta.columns[<column>] の displayName / tags / color / notes） */
  | { kind: "column"; tableId: string; column: string };

/**
 * ダイアログを開くきっかけになった項目（R-05）。
 * 一覧では項目ごとにペンを出すため、押した項目の入力欄へ初期フォーカスを当てる
 * （論理名のペンから開いたのにタグへ入力させない）。
 */
export type MetaField = keyof MetaFields;

/** ダイアログで編集する4項目（テーブル・カラムとも同じ形） */
export interface MetaFields {
  displayName: string;
  tags: string[];
  /** 色トークン。"" は未設定 */
  color: string;
  notes: string;
}

/** 今の値（ダイアログの初期値） */
export function readMetaFields(table: Table, target: MetaTarget): MetaFields {
  if (target.kind === "table") {
    return {
      displayName: table.meta?.displayName ?? "",
      tags: [...(table.meta?.tags ?? [])],
      color: table.meta?.color ?? "",
      notes: table.meta?.notes ?? "",
    };
  }
  const cm = table.meta?.columns?.[target.column];
  return {
    displayName: cm?.displayName ?? "",
    tags: [...(cm?.tags ?? [])],
    color: cm?.color ?? "",
    notes: cm?.notes ?? "",
  };
}

/**
 * 読み直したドラフトの対象の4項目だけを差し替える。カラムが見当たらない
 * （他で消された）ときは null を返して保存を中止する（saveTableMeta が stale として扱う）。
 */
export function writeMetaFields(draft: MetaDraft, target: MetaTarget, fields: MetaFields): MetaDraft | null {
  if (target.kind === "table") {
    return { ...draft, ...fields };
  }
  const cm = draft.columns[target.column];
  if (cm === undefined) return null;
  return { ...draft, columns: { ...draft.columns, [target.column]: { ...cm, ...fields } } };
}
