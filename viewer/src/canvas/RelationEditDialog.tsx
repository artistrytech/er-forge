/**
 * ER図の編集モードから開く、リレーションの編集ダイアログ（P-11 / P-07）。
 *
 * 閲覧ルートで開く {@link RelationDialog} は読み取り専用のままにする（「閲覧は閲覧だけ」を
 * 崩さない）。編集できるのはここ = **ER図の編集モード中にエッジをダブルクリックしたとき**だけ。
 *
 * テーブル編集画面（TableEdit）が「開いて編集して明示保存」なのに対し、こちらは
 * **確定 = 1回の保存**（saveTableMeta）で完結する。配置編集のコマンド列とは別の経路であり、
 * Undo / Redo の対象にはならない。
 *
 * 編集の対象はどちらも参照元（子）テーブルのファイルである:
 * - 物理FK: カーディナリティと注記のみ（定義は machine-owned。J-01〜J-04）
 * - 論理外部制約: 定義・カーディナリティ・注記の全部と、削除
 */
import { useCallback, useMemo, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { LogicalFkDialog, PhysicalFkDialog } from "../catalog/ConstraintDialog";
import { saveTableMeta } from "../model/editStore";
import {
  EMPTY_CARDINALITY,
  newUid,
  type DraftCardinality,
  type DraftLogicalFk,
  type MetaDraft,
} from "../model/metaDraft";
import { useAppStore } from "../model/store";
import { useTableDraft } from "../model/useTableDraft";
import { parseEdgeId, type Table } from "../model/types";
import { Button } from "../ui/Button";
import { ConstraintDeleteDialog } from "../ui/ConstraintDeleteDialog";
import { Dialog } from "../ui/Dialog";

/** 保存の進行状態（ダイアログは失敗しても閉じない。入力を失わせないため） */
interface SaveState {
  busy: boolean;
  error: string | null;
}

const IDLE: SaveState = { busy: false, error: null };

export function RelationEditDialog({ relationId }: { relationId: string }) {
  const { t } = useI18n();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const addToast = useAppStore((s) => s.addToast);
  const parts = parseEdgeId(relationId);
  const { table, draft } = useTableDraft(parts?.tableId ?? null);
  const [save, setSave] = useState<SaveState>(IDLE);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /** 保存を実行し、成功したら閉じる。失敗理由はダイアログに出したまま残す */
  const run = useCallback(
    async (tableId: string, edit: (d: MetaDraft, t: Table) => MetaDraft | null, doneMessage: string) => {
      setSave({ busy: true, error: null });
      const result = await saveTableMeta(tableId, edit);
      if (result.ok) {
        addToast(doneMessage);
        closeDialog();
        return;
      }
      setSave({ busy: false, error: result.message });
    },
    [addToast, closeDialog],
  );

  if (parts === null) {
    return (
      <Dialog title={t("relation.title")} onClose={closeDialog}>
        <p className="error-text">{t("relation.notFound", { id: relationId })}</p>
      </Dialog>
    );
  }
  if (table === null || draft === null) {
    return (
      <Dialog title={t("relation.title")} onClose={closeDialog}>
        <p className="muted">{t("table.loading")}</p>
      </Dialog>
    );
  }

  const { tableId, kind, constraintName } = parts;

  // ---- 物理FK: カーディナリティと注記だけ（定義は変えられない） ----
  if (kind === "fk") {
    const fk = (table.foreignKeys ?? []).find((f) => f.name === constraintName);
    if (fk === undefined) {
      return (
        <Dialog title={t("relation.title")} onClose={closeDialog}>
          <p className="error-text">{t("relation.notFound", { id: relationId })}</p>
        </Dialog>
      );
    }
    return (
      <PhysicalFkDialog
        table={table}
        fk={fk}
        initial={draft.physicalCardinality[constraintName] ?? { ...EMPTY_CARDINALITY }}
        busy={save.busy}
        error={save.error}
        onClose={closeDialog}
        onSubmit={(cardinality) => {
          void run(
            tableId,
            (d) =>
              constraintName in d.physicalCardinality
                ? {
                    ...d,
                    physicalCardinality: { ...d.physicalCardinality, [constraintName]: cardinality },
                  }
                : null,
            t("relationEdit.saved"),
          );
        }}
      />
    );
  }

  // ---- 論理外部制約: 定義ごと編集でき、削除もできる ----
  const row = draft.logicalForeignKeys.find((x) => x.name.trim() === constraintName);
  if (row === undefined) {
    return (
      <Dialog title={t("relation.title")} onClose={closeDialog}>
        <p className="error-text">{t("relation.notFound", { id: relationId })}</p>
      </Dialog>
    );
  }

  // 削除の確認と実行は詳細ダイアログと共通（確定＝即時保存。Undo では戻らない）
  if (confirmDelete) {
    return (
      <ConstraintDeleteDialog
        target={{ kind: "logicalFk", tableId, name: constraintName }}
        name={constraintName}
        onCancel={() => setConfirmDelete(false)}
        onDeleted={closeDialog}
      />
    );
  }

  return (
    <LogicalFkDialog
      table={table}
      initial={row}
      taken={
        new Set(
          draft.logicalForeignKeys
            .filter((x) => x.uid !== row.uid)
            .map((x) => x.name.trim())
            .filter((n) => n !== ""),
        )
      }
      busy={save.busy}
      error={save.error}
      extraActions={
        <Button
          variant="danger"
          data-testid="relation-delete"
          disabled={save.busy}
          onClick={() => setConfirmDelete(true)}
        >
          {t("tableEdit.remove")}
        </Button>
      }
      onClose={closeDialog}
      onSubmit={(next) => {
        void run(
          tableId,
          (d) => {
            const i = d.logicalForeignKeys.findIndex((x) => x.name.trim() === constraintName);
            if (i < 0) return null; // 他で消された / 名前が変わった
            const rows = [...d.logicalForeignKeys];
            rows[i] = { ...next, uid: rows[i]!.uid };
            return { ...d, logicalForeignKeys: rows };
          },
          t("relationEdit.saved"),
        );
      }}
    />
  );
}

/**
 * ER図での論理外部制約の作成（3段階のうちの最後）。
 * 参照元・参照先はキャンバス上で選び終えており、ここで残りを決めて確定 = 即時保存する。
 */
export function LogicalFkCreateDialog({
  fromId,
  toId,
  onClose,
}: {
  fromId: string;
  toId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const addToast = useAppStore((s) => s.addToast);
  const { table, draft } = useTableDraft(fromId);
  const [save, setSave] = useState<SaveState>(IDLE);
  // 参照先だけ埋めた新規行。uid は画面内だけの識別子（保存されない）
  const initial = useMemo<DraftLogicalFk>(
    () => ({
      uid: newUid(),
      name: "",
      columns: [],
      refTable: toId,
      refColumns: [],
      notes: "",
      cardinality: { ...EMPTY_CARDINALITY } as DraftCardinality,
    }),
    [toId],
  );

  if (table === null || draft === null) {
    return (
      <Dialog title={t("tableEdit.fkAddTitle")} onClose={onClose}>
        <p className="muted">{t("table.loading")}</p>
      </Dialog>
    );
  }

  return (
    <LogicalFkDialog
      table={table}
      initial={initial}
      adding
      taken={
        new Set(
          draft.logicalForeignKeys.map((x) => x.name.trim()).filter((n) => n !== ""),
        )
      }
      busy={save.busy}
      error={save.error}
      onClose={onClose}
      onSubmit={(next) => {
        void (async () => {
          setSave({ busy: true, error: null });
          const result = await saveTableMeta(fromId, (d) => ({
            ...d,
            logicalForeignKeys: [...d.logicalForeignKeys, next],
          }));
          if (result.ok) {
            addToast(t("relationEdit.created"));
            onClose();
            return;
          }
          setSave({ busy: false, error: result.message });
        })();
      }}
    />
  );
}
