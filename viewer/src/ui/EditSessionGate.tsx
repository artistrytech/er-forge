/**
 * 編集フォーム（O-03 / P-03）の編集セッションゲート。
 *
 * 編集画面に入る時点で編集セッションを開始し、ロックを取得する（O-03 詳細設計 §1.1）。
 * ロックが取れない場合は既存の lockBusy ダイアログ（強制取得つき）が表示される。
 * 取得できるまでフォームは無効化し、このバナーから再試行できる。
 */
import { useEffect } from "react";
import { useI18n } from "../i18n/useI18n";
import { useEditStore } from "../model/editStore";

/** ロック保持中（= フォームを有効にしてよい）かどうか */
export function useFormSessionReady(): boolean {
  const session = useEditStore((s) => s.session);
  const requestStart = useEditStore((s) => s.requestStartEditing);

  // 画面に入ったら自動でセッション開始を試みる（既に編集中なら何もしない）
  useEffect(() => {
    if (useEditStore.getState().session !== "editing") {
      requestStart();
    }
  }, [requestStart]);

  return session === "editing";
}

export function EditSessionGate() {
  const { t } = useI18n();
  const session = useEditStore((s) => s.session);
  const requestStart = useEditStore((s) => s.requestStartEditing);
  if (session === "editing") return null;
  return (
    <div className="notice-banner form-gate">
      {t("editGate.body")}
      <button type="button" className="header-button header-button-primary" onClick={requestStart}>
        {t("session.startEdit")}
      </button>
    </div>
  );
}
