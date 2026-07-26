/**
 * 空プロジェクトの初期化（A-08 / §3.6）。
 * サーバーモード + データ0件のときだけ表示される。
 */
import { useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { apiPost, wpath } from "../model/api";
import { useAppStore } from "../model/store";
import { Button } from "./Button";
import { Link } from "./Link";
import { hrefs } from "./router";
import { WorkspaceDeleteDialog, WorkspaceMenu } from "./Workspace";
import styles from "./BootstrapScreen.module.scss";

export function BootstrapScreen() {
  const { t } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode) === true;
  const workspaces = useAppStore((s) => s.workspaces);
  const workspaceId = useAppStore((s) => s.workspaceId);
  const workspace = (serverMode && workspaces.find((w) => w.id === workspaceId)) || null;
  const workspaceName = workspaces.find((w) => w.id === workspaceId)?.name;
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importSample = () => {
    setRunning(true);
    setError(null);
    apiPost(wpath("/bootstrap"), { mode: "sample" })
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
        {/* このワークスペースはまだ空、という状態。ここからも他のワークスペースへ移れる
            （移れないと、2つ目を作った直後に元へ戻る導線が URL しかなくなる） */}
        <h1 className={styles.bootstrapTitle}>
          {workspaceName ?? t("app.title")}
          <WorkspaceMenu />
        </h1>
        <p>{t("bootstrap.lead")}</p>
        <div className={styles.bootstrapOptions}>
          <div className={styles.bootstrapOption}>
            <h2>{t("bootstrap.introspect")}</h2>
            <p>{t("bootstrap.introspectDesc")}</p>
            <Link className="button-link" href={hrefs.introspect()}>
              {t("bootstrap.introspect")}
            </Link>
          </div>
          <div className={styles.bootstrapOption}>
            <h2>{t("bootstrap.sample")}</h2>
            <p>{t("bootstrap.sampleDesc")}</p>
            <Button
              variant="accent"
              data-testid="bootstrap-sample"
              disabled={running}
              onClick={importSample}
            >
              {running ? t("bootstrap.running") : t("bootstrap.sample")}
            </Button>
          </div>
        </div>
        {error !== null && (
          <p className={styles.bootstrapError}>{t("bootstrap.failed", { error })}</p>
        )}
        {/* 空のワークスペースをやめる導線。この画面にはヘッダ（設定メニュー）が無いため、
            ここに置かないと「作ってみたが要らない」を URL 操作なしで戻せない */}
        {workspace !== null && (
          <p className={styles.bootstrapFooter}>
            <Button
              variant="danger"
              data-testid="workspace-delete"
              onClick={() => setDeleting(true)}
            >
              {t("workspace.deleteAction")}
            </Button>
          </p>
        )}
      </div>
      {deleting && workspace !== null && (
        <WorkspaceDeleteDialog workspace={workspace} onClose={() => setDeleting(false)} />
      )}
    </div>
  );
}
