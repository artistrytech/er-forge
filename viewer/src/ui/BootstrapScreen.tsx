/**
 * 空プロジェクトの初期化（A-08 / §3.6）。
 * サーバーモード + データ0件のときだけ表示される。
 * 「既存のスキーマから生成する」は逆生成（フェーズ5）の実装後に有効化する。
 */
import { useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { apiPost } from "../model/api";

export function BootstrapScreen() {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importSample = () => {
    setRunning(true);
    setError(null);
    apiPost("/__erd/bootstrap", { mode: "sample" })
      .then((res) => {
        if (res.status === 200) {
          // データが書き出された。リロードで通常のロードシーケンスに入る
          location.reload();
        } else {
          setRunning(false);
          setError(res.body || String(res.status));
        }
      })
      .catch((e: unknown) => {
        setRunning(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <div className="fatal-screen bootstrap-screen">
      <div className="fatal-card">
        <h1>{t("app.title")}</h1>
        <p>{t("bootstrap.lead")}</p>
        <div className="bootstrap-options">
          <div className="bootstrap-option bootstrap-option-disabled">
            <h2>{t("bootstrap.introspect")}</h2>
            <p>{t("bootstrap.introspectDesc")}</p>
            <button type="button" disabled>
              {t("bootstrap.notImplemented")}
            </button>
          </div>
          <div className="bootstrap-option">
            <h2>{t("bootstrap.sample")}</h2>
            <p>{t("bootstrap.sampleDesc")}</p>
            <button
              type="button"
              data-testid="bootstrap-sample"
              disabled={running}
              onClick={importSample}
            >
              {running ? t("bootstrap.running") : t("bootstrap.sample")}
            </button>
          </div>
        </div>
        {error !== null && (
          <p className="bootstrap-error">{t("bootstrap.failed", { error })}</p>
        )}
      </div>
    </div>
  );
}
