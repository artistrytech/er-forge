/**
 * 論理制約（論理外部制約 / 論理一意制約）を削除する確認（R-05）。
 *
 * 詳細ダイアログ（リレーション / 制約）と ER図のリレーション編集（E-11）で共用する。
 * どちらも元のダイアログを**置き換える**かたちで出し、取消でそこへ戻る（ダイアログを
 * さらに重ねない — 消すか戻るかの二択に、下の内容は読めなくてよい）。
 *
 * 削除は確定＝即時保存（saveTableMeta）で、配置編集の Undo では戻らない。失敗したら
 * 理由をここに出したまま残し、成功したら呼び出し元を閉じてトーストで知らせる。
 */
import { useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { removeConstraint, type ConstraintTarget } from "../model/constraintTarget";
import { saveTableMeta } from "../model/editStore";
import { useAppStore } from "../model/store";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export function ConstraintDeleteDialog({
  target,
  name,
  onCancel,
  onDeleted,
}: {
  target: ConstraintTarget;
  /** 確認文に出す制約名（名前の無い論理一意制約では undefined） */
  name?: string;
  /** 取消・× ・Esc（元のダイアログへ戻す） */
  onCancel: () => void;
  /** 削除できた（呼び出し元のダイアログを閉じる） */
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFk = target.kind === "logicalFk";

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await saveTableMeta(target.tableId, (draft) => removeConstraint(draft, target));
    if (result.ok) {
      addToast(t(isFk ? "constraintDelete.fkDone" : "constraintDelete.ukDone"));
      onDeleted();
      return;
    }
    setBusy(false);
    setError(result.message);
  };

  return (
    <Dialog
      title={t(isFk ? "constraintDelete.fkTitle" : "constraintDelete.ukTitle")}
      onClose={onCancel}
    >
      <p>
        {name === undefined
          ? t("constraintDelete.bodyUnnamed")
          : t("constraintDelete.body", { name })}
      </p>
      <p className="muted form-hint">{t("constraintDelete.hint")}</p>
      {error !== null && <p className="error-text">{error}</p>}
      <div className="dialog-actions">
        <Button
          variant="danger"
          data-testid="constraint-delete-confirm"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? t("tableEdit.saving") : t("tableEdit.remove")}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          {t("dialog.cancel")}
        </Button>
      </div>
    </Dialog>
  );
}
