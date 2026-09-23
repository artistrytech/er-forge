/**
 * 制約の詳細ダイアログ（閲覧）から開く、1項目だけの編集ダイアログ（R-05）。
 *
 * - {@link CardinalityEditDialog}: カーディナリティの上書き（物理FK / 論理外部制約）
 * - {@link FkColumnsDialog}: 論理外部制約のカラム対応
 * - {@link UniqueColumnsDialog}: 論理一意制約の対象カラム
 *
 * 注記のように本文の位置をそのまま入力欄に変える（インライン）わけにいかない項目 —
 * 選択肢の組み合わせで決まるもの — を、**別ダイアログ**に出す。詳細の上に重なり、
 * 閉じると詳細へ戻る（`appStore.dialogs` の積み重ね）。
 *
 * 入力部品はテーブル編集画面・ER図のリレーション編集と同じ（`ConstraintDialog` の
 * `CardinalityFields` / `ColumnPairsField` / `UniqueColumnsField`）で、
 * 確定＝即時保存（`saveTableMeta`。読み直し → `baseHash` → PUT）。
 * 失敗したら入力を残したままダイアログに理由を出す（ER図のリレーション編集と同じ）。
 */
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";
import {
  CardinalityFields,
  ColumnPairsField,
  UniqueColumnsField,
  toColumnRows,
  toPairRows,
  type ColumnRow,
  type PairRow,
} from "../catalog/ConstraintDialog";
import { writeCardinality, writeFkColumns, writeUniqueColumns } from "../model/constraintEdit";
import { saveTableMeta } from "../model/editStore";
import type { DraftCardinality, MetaDraft } from "../model/metaDraft";
import { useAppStore } from "../model/store";
import { useTableDraft } from "../model/useTableDraft";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/**
 * 1項目の編集ダイアログの共通の枠（見出し・補足・[確定] / [キャンセル]）。
 * 確定できない理由（blocked）は出したまま押させない（保存して初めて怒られない）。
 */
function EditShell({
  title,
  hint,
  blocked,
  busy,
  error,
  children,
  onSubmit,
  onClose,
}: {
  title: ReactNode;
  hint: string;
  blocked: string | null;
  busy: boolean;
  error: string | null;
  children: ReactNode;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="muted form-hint">{hint}</p>
      {children}
      {blocked !== null && <p className="muted form-hint">{blocked}</p>}
      {error !== null && (
        <p className="error-text" data-testid="constraint-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <Button
          variant="primary"
          data-testid="constraint-submit"
          disabled={blocked !== null || busy}
          onClick={onSubmit}
        >
          {busy ? t("tableEdit.saving") : t("tableEdit.applyEdit")}
        </Button>
        <Button onClick={onClose} disabled={busy}>
          {t("dialog.cancel")}
        </Button>
      </div>
    </Dialog>
  );
}

/** 読み込み中の器（対象が見当たらないときはその旨を出して閉じるだけにする） */
function Pending({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="muted">{message}</p>
    </Dialog>
  );
}

/** 保存を実行し、成功したら閉じる。失敗理由はダイアログに出したまま残す */
function useSaveOnce(tableId: string): {
  busy: boolean;
  error: string | null;
  run: (edit: (draft: MetaDraft) => MetaDraft | null) => void;
} {
  const { t } = useI18n();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (edit: (draft: MetaDraft) => MetaDraft | null): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      const result = await saveTableMeta(tableId, (draft) => edit(draft));
      if (result.ok) {
        addToast(t("relationEdit.saved"));
        closeDialog();
        return;
      }
      setBusy(false);
      setError(result.message);
    })();
  };
  return { busy, error, run };
}

// ------------------------------------------------------------------ カーディナリティ

export function CardinalityEditDialog({
  tableId,
  kind,
  name,
}: {
  tableId: string;
  /** 物理FK（fk）/ 論理外部制約（lfk）。どちらも参照元テーブルのファイルに書く */
  kind: "fk" | "lfk";
  name: string;
}) {
  const { t } = useI18n();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const { draft } = useTableDraft(tableId);
  const { busy, error, run } = useSaveOnce(tableId);
  const current =
    draft === null
      ? undefined
      : kind === "fk"
        ? draft.physicalCardinality[name]
        : draft.logicalForeignKeys.find((fk) => fk.name.trim() === name)?.cardinality;
  // 初期値は読めた時点で1回だけ取る（保存の読み直しで入力を巻き戻さない）
  const [value, setValue] = useState<DraftCardinality | null>(null);
  useEffect(() => {
    setValue((v) => (v === null && current !== undefined ? { ...current } : v));
  }, [current]);

  if (value === null) {
    return (
      <Pending
        title={t("cardinalityEdit.title")}
        message={draft === null ? t("table.loading") : t("constraint.notFound")}
        onClose={closeDialog}
      />
    );
  }

  return (
    <EditShell
      title={t("cardinalityEdit.title")}
      hint={t("cardinalityEdit.hint")}
      blocked={null}
      busy={busy}
      error={error}
      onClose={closeDialog}
      onSubmit={() => run((d) => writeCardinality(d, { kind, name }, value))}
    >
      {/* 補足（多重度の根拠）はリレーション詳細の中でその場編集する（同じ項目を2か所に置かない） */}
      <CardinalityFields
        value={value}
        relationId={`${tableId}#${kind}:${name}`}
        showNotes={false}
        onChange={setValue}
      />
    </EditShell>
  );
}

// ------------------------------------------------------------------ カラム対応（論理外部制約）

export function FkColumnsDialog({ tableId, name }: { tableId: string; name: string }) {
  const { t } = useI18n();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const { table, draft } = useTableDraft(tableId);
  const { busy, error, run } = useSaveOnce(tableId);
  const row = draft?.logicalForeignKeys.find((fk) => fk.name.trim() === name);
  const [pairs, setPairs] = useState<PairRow[] | null>(null);
  useEffect(() => {
    setPairs((p) => (p === null && row !== undefined ? toPairRows(row.columns, row.refColumns) : p));
  }, [row]);

  if (table === null || row === undefined || pairs === null) {
    return (
      <Pending
        title={t("fkColumns.title")}
        message={draft === null ? t("table.loading") : t("constraint.notFound")}
        onClose={closeDialog}
      />
    );
  }

  const columns = pairs.map((p) => p.column);
  const refColumns = pairs.map((p) => p.refColumn);
  const blocked =
    pairs.length === 0 || columns.some((c) => c === "") || refColumns.some((c) => c === "")
      ? t("tableEdit.needPairs")
      : null;

  return (
    <EditShell
      title={
        <>
          {t("fkColumns.title")}: <span className="mono">{name}</span>
        </>
      }
      hint={t("fkColumns.hint")}
      blocked={blocked}
      busy={busy}
      error={error}
      onClose={closeDialog}
      onSubmit={() => run((d) => writeFkColumns(d, name, columns, refColumns))}
    >
      {/* 参照先テーブルは変えない（変えると別の制約になる。テーブル編集画面・ER図で行う） */}
      <ColumnPairsField table={table} refTable={row.refTable} pairs={pairs} onChange={setPairs} />
    </EditShell>
  );
}

// ------------------------------------------------------------------ 対象カラム（論理一意制約）

export function UniqueColumnsDialog({
  tableId,
  at,
  name,
}: {
  tableId: string;
  at: number;
  /** 保存時の食い違い検出に使う（名前を持たない制約では undefined） */
  name?: string;
}) {
  const { t } = useI18n();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const { table, draft } = useTableDraft(tableId);
  const { busy, error, run } = useSaveOnce(tableId);
  const unique = draft?.logicalUniques[at];
  const [rows, setRows] = useState<ColumnRow[] | null>(null);
  useEffect(() => {
    setRows((r) => (r === null && unique !== undefined ? toColumnRows(unique.columns) : r));
  }, [unique]);

  if (table === null || unique === undefined || rows === null) {
    return (
      <Pending
        title={t("uniqueColumns.title")}
        message={draft === null ? t("table.loading") : t("constraint.notFound")}
        onClose={closeDialog}
      />
    );
  }

  const columns = rows.map((r) => r.column);
  const blocked =
    rows.length === 0 || columns.some((c) => c === "") ? t("tableEdit.needColumns") : null;

  return (
    <EditShell
      title={
        name === undefined ? (
          t("uniqueColumns.title")
        ) : (
          <>
            {t("uniqueColumns.title")}: <span className="mono">{name}</span>
          </>
        )
      }
      hint={t("uniqueColumns.hint")}
      blocked={blocked}
      busy={busy}
      error={error}
      onClose={closeDialog}
      onSubmit={() => run((d) => writeUniqueColumns(d, { at, name }, columns))}
    >
      <UniqueColumnsField table={table} rows={rows} onChange={setRows} />
    </EditShell>
  );
}
