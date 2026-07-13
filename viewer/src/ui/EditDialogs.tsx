/**
 * 編集セッション関連のダイアログ・バナー・トースト（H-09〜H-13 / M-01 / M-02）。
 * - 静的モードの編集開始警告（§8.1）
 * - 編集ロック競合（423。強制取得あり。§2.3）/ ロック喪失
 * - 保存競合（409 STALE。§4.3）— 自動でどちらかを選ばない（INV-1）
 * - 現在ページの外部変更バナー（H-09）
 * - 編集終了時の未保存確認
 */
import { useI18n } from "../i18n/useI18n";
import { useEditStore } from "../model/editStore";
import { useAppStore } from "../model/store";
import { Dialog } from "./Dialog";

export function EditDialogs() {
  const { t } = useI18n();
  const dialog = useEditStore((s) => s.dialog);
  const closeDialog = useEditStore((s) => s.closeDialog);
  const confirmStart = useEditStore((s) => s.confirmStartEditing);
  const stopEditing = useEditStore((s) => s.stopEditing);
  const resolveConflict = useEditStore((s) => s.resolveConflict);
  const openExport = useEditStore((s) => s.openExport);
  const currentDiagramId = useAppStore((s) => s.currentDiagramId);

  if (!dialog) return null;

  switch (dialog.type) {
    case "staticWarn":
      return (
        <Dialog title={t("edit.staticWarn.title")} onClose={closeDialog}>
          <p>{t("edit.staticWarn.body")}</p>
          <div className="dialog-actions">
            <button type="button" data-testid="static-edit-ok" onClick={() => confirmStart(false)}>
              {t("edit.staticWarn.ok")}
            </button>
            <button type="button" onClick={closeDialog}>
              {t("dialog.cancel")}
            </button>
          </div>
        </Dialog>
      );
    case "lockBusy":
      return (
        <Dialog title={t("edit.lockBusy.title")} onClose={closeDialog}>
          <p>{t("edit.lockBusy.body")}</p>
          {dialog.lastHeartbeat !== undefined && (
            <p className="dialog-note">
              {t("edit.lockBusy.lastHeartbeat", { time: dialog.lastHeartbeat })}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" data-testid="lock-force" onClick={() => confirmStart(true)}>
              {t("edit.lockBusy.force")}
            </button>
            <button type="button" onClick={closeDialog}>
              {t("dialog.cancel")}
            </button>
          </div>
        </Dialog>
      );
    case "lockLost":
      return (
        <Dialog title={t("edit.lockLost.title")} onClose={closeDialog}>
          <p>{t("edit.lockLost.body")}</p>
          <div className="dialog-actions">
            {currentDiagramId !== null && (
              <button
                type="button"
                onClick={() => {
                  closeDialog();
                  openExport(currentDiagramId);
                }}
              >
                {t("edit.exportButton")}
              </button>
            )}
            <button type="button" onClick={closeDialog}>
              {t("export.close")}
            </button>
          </div>
        </Dialog>
      );
    case "stopConfirm":
      return (
        <Dialog title={t("edit.stopConfirm.title")} onClose={() => stopEditing("cancel")}>
          <p>{t("edit.stopConfirm.body")}</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => stopEditing("save")}>
              {t("edit.stopConfirm.save")}
            </button>
            <button type="button" data-testid="stop-discard" onClick={() => stopEditing("discard")}>
              {t("edit.stopConfirm.discard")}
            </button>
            <button type="button" onClick={() => stopEditing("cancel")}>
              {t("dialog.cancel")}
            </button>
          </div>
        </Dialog>
      );
    case "conflict":
      return (
        <Dialog title={t("edit.conflict.title")} onClose={closeDialog}>
          <p>{t("edit.conflict.body", { file: `data/diagrams/${dialog.diagramId}.js` })}</p>
          <div className="dialog-actions">
            <button type="button" data-testid="conflict-reload" onClick={() => resolveConflict("reload")}>
              {t("edit.conflict.reload")}
            </button>
            <button
              type="button"
              data-testid="conflict-overwrite"
              onClick={() => resolveConflict("overwrite")}
            >
              {t("edit.conflict.overwrite")}
            </button>
          </div>
        </Dialog>
      );
  }
}

/** 現在ページが外部で更新されたときの選択バナー（H-09。未保存ありのため自動反映しない） */
export function ExternalUpdateBanner() {
  const { t } = useI18n();
  const externalUpdate = useEditStore((s) => s.externalUpdate);
  const resolveExternal = useEditStore((s) => s.resolveExternal);
  if (!externalUpdate) return null;
  return (
    <div className="external-banner" data-testid="external-banner">
      <span>{t("edit.external.body")}</span>
      <button type="button" onClick={() => resolveExternal("overwrite")}>
        {t("edit.external.overwrite")}
      </button>
      <button type="button" data-testid="external-reload" onClick={() => resolveExternal("reload")}>
        {t("edit.external.reload")}
      </button>
    </div>
  );
}

/** トースト（M-01）。閲覧を妨げない非侵襲の通知 */
export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-area" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          {toast.text}
        </div>
      ))}
    </div>
  );
}
