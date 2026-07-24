/**
 * 編集関連のダイアログ・バナー・トースト（H-09 / H-12 / M-01 / M-02）。
 * - 保存競合（409 STALE。§4.3）— 自動でどちらかを選ばない（INV-1）
 * - 現在ページの外部変更バナー（H-09。編集ルート滞在中のみ。§6.2）
 *
 * 編集ロックは廃止したため、ロック競合 / ロック喪失 / 静的モード開始警告 / 終了確認の
 * ダイアログは無い（静的モードの警告はヘッダに常時表示、終了確認は離脱ガードで行う）。
 */
import { useI18n } from "../i18n/useI18n";
import { useEditStore } from "../model/editStore";
import { useAppStore } from "../model/store";
import { Dialog } from "./Dialog";

export function EditDialogs() {
  const { t } = useI18n();
  const dialog = useEditStore((s) => s.dialog);
  const closeDialog = useEditStore((s) => s.closeDialog);
  const resolveConflict = useEditStore((s) => s.resolveConflict);

  if (!dialog) return null;

  // 保存時の競合（409 STALE）。再読込 / 上書きのどちらかを人が選ぶ（INV-1）
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

/**
 * 現在ページが外部で更新されたときのバナー（H-09 / §6.2）。編集ルート滞在中のみ出る。
 * 他の通知より重要度が高いためトーストではなくバナーとする。二重には開かない（単一の状態）。
 * [再読込] = 破棄して再読込 / [無視] = 編集を続ける（保存時 409 STALE で守られる）。
 * 「このタブ内では通知しない」で以後このタブでは出さない（sessionStorage）。
 */
export function ExternalUpdateBanner() {
  const { t } = useI18n();
  const externalUpdate = useEditStore((s) => s.externalUpdate);
  const resolveExternal = useEditStore((s) => s.resolveExternal);
  const muteForTab = useEditStore((s) => s.muteExternalForTab);
  if (!externalUpdate) return null;
  return (
    <div className="external-banner" data-testid="external-banner">
      <span>{t("edit.external.body")}</span>
      <button type="button" data-testid="external-reload" onClick={() => resolveExternal("reload")}>
        {t("edit.external.reload")}
      </button>
      <button type="button" data-testid="external-ignore" onClick={() => resolveExternal("ignore")}>
        {t("edit.external.ignore")}
      </button>
      <label className="external-mute">
        <input type="checkbox" data-testid="external-mute" onChange={() => muteForTab()} />
        {t("edit.external.muteTab")}
      </label>
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
        <div
          key={toast.id}
          className={"toast" + (toast.variant === "error" ? " toast-error" : "")}
          role={toast.variant === "error" ? "alert" : undefined}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}
