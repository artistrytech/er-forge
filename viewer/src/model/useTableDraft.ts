/**
 * テーブルを読み、その内容から編集用のドラフト（{@link MetaDraft}）を作るフック。
 *
 * 確定＝即時保存のダイアログ（ER図のリレーション編集 E-11 / 詳細ダイアログからの
 * カーディナリティ・カラム対応の編集 R-05）で共用する。
 *
 * buildDraft は呼ぶたびに新しい uid を振るため、描画のたびに作り直すと行の同一性が崩れる
 * （同じテーブルなら同じドラフトを使い回す）。
 *
 * **一度読めたテーブルは、消えても手元に残す**。保存（saveTableMeta）は読み直しのために
 * 一瞬ストアから消すため、素直に追随すると保存中だけ「読み込み中」に戻り、
 * ダイアログが作り直されて入力途中の内容が消えてしまう。
 */
import { useEffect, useMemo, useRef } from "react";
import { loadTable } from "./loader";
import { buildDraft, type MetaDraft } from "./metaDraft";
import { useAppStore } from "./store";
import type { Table } from "./types";

export function useTableDraft(tableId: string | null): { table: Table | null; draft: MetaDraft | null } {
  const stored = useAppStore((s) => (tableId === null ? undefined : s.tables[tableId]));
  const held = useRef<{ id: string | null; table: Table } | null>(null);
  useEffect(() => {
    if (tableId !== null) void loadTable(tableId);
  }, [tableId]);
  if (stored !== undefined) held.current = { id: tableId, table: stored };
  const table = stored ?? (held.current?.id === tableId ? held.current.table : undefined);
  const draft = useMemo(() => (table === undefined ? null : buildDraft(table)), [table]);
  return { table: table ?? null, draft };
}
