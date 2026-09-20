/**
 * 閲覧用 ZIP の書き出し（A-11 / 設計書 §3.2）。
 *
 * ZIP を組み立てるのはサーバー（`ViewerExport`）で、ここは「何を・どんな名前で」を選ぶ画面。
 * **CLI（`erd export`）と同じ処理**を呼ぶので、同じ選択なら同じ中身の ZIP が出る。
 * その対応が分かるよう、選択と等価なコマンド文字列を常に表示してコピーできるようにしている
 * （定期的に作り直す運用へ移りたくなったとき、ここから持ち出せる）。
 *
 * サーバーモード専用。静的モードでは `index.html` 自身を読めないため成立しない。
 */
import { useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { downloadBlob } from "../lib/download";
import {
  DEFAULT_EXPORT_PREFIX,
  exportCommand,
  exportPrefixError,
  isWindows,
} from "../lib/viewerExport";
import { apiPostBlob } from "../model/api";
import { useAppStore } from "../model/store";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import styles from "./ViewerExportDialog.module.scss";

/** エラー応答（`{ code, message }`）から message を取り出す。JSON でなければ null。 */
async function serverMessage(body: Blob): Promise<string | null> {
  try {
    const parsed = JSON.parse(await body.text()) as { message?: unknown };
    return typeof parsed.message === "string" && parsed.message !== "" ? parsed.message : null;
  } catch {
    return null;
  }
}

export function ViewerExportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const workspaces = useAppStore((s) => s.workspaces);
  const currentId = useAppStore((s) => s.workspaceId);
  const addToast = useAppStore((s) => s.addToast);

  const [prefix, setPrefix] = useState(DEFAULT_EXPORT_PREFIX);
  const [selected, setSelected] = useState<string[]>(() => workspaces.map((w) => w.id));
  const [busy, setBusy] = useState(false);
  const commandRef = useRef<HTMLTextAreaElement>(null);

  const errorKey = exportPrefixError(prefix);
  const nothingSelected = selected.length === 0;
  const command = useMemo(
    () =>
      exportCommand({
        prefix,
        workspaces: selected,
        total: workspaces.length,
        windows: isWindows(),
      }),
    [prefix, selected, workspaces.length],
  );

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      // 全選択なら workspaces を送らない（CLI の既定と揃える）
      const all = selected.length === workspaces.length;
      const res = await apiPostBlob("/__erd/export/viewer", {
        prefix,
        workspaces: all ? [] : selected,
      });
      if (res.status !== 200) {
        // 失敗の理由はサーバーが JSON で返す（index.html が無い、など）。黙って落とすと
        // 手の打ちようがないので、そのまま添えて出す
        const reason = await serverMessage(res.blob);
        addToast(
          reason === null ? t("viewerExport.failed") : `${t("viewerExport.failed")}: ${reason}`,
          "error",
        );
        return;
      }
      downloadBlob(res.fileName === "" ? `${prefix}.zip` : res.fileName, res.blob);
      addToast(t("viewerExport.done", { n: selected.length }));
      onClose();
    } catch {
      addToast(t("viewerExport.failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const copyCommand = () => {
    const area = commandRef.current;
    if (!area) return;
    area.select();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(command).catch(() => document.execCommand("copy"));
    } else {
      document.execCommand("copy");
    }
    addToast(t("viewerExport.commandCopied"));
  };

  return (
    <Dialog title={t("viewerExport.title")} onClose={onClose}>
      <p className={styles.hint}>{t("viewerExport.hint")}</p>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="viewer-export-prefix">
          {t("viewerExport.prefix")}
        </label>
        <input
          id="viewer-export-prefix"
          className={styles.prefixInput}
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          aria-invalid={errorKey !== null}
          spellCheck={false}
          data-testid="viewer-export-prefix"
        />
        {errorKey !== null ? (
          <div className={styles.error} data-testid="viewer-export-error">
            {t(errorKey)}
          </div>
        ) : (
          <div className={styles.fileName}>{t("viewerExport.fileName", { name: prefix })}</div>
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>{t("viewerExport.workspaces")}</span>
        <div className={styles.workspaces} data-testid="viewer-export-workspaces">
          {workspaces.map((w) => (
            <label key={w.id} className={styles.workspace}>
              <input
                type="checkbox"
                checked={selected.includes(w.id)}
                onChange={() => toggle(w.id)}
                data-testid="viewer-export-workspace"
                data-workspace-id={w.id}
              />
              <span>{w.name}</span>
              <span className={styles.workspaceId}>
                {w.id}
                {w.id === currentId ? ` (${t("viewerExport.current")})` : ""}
              </span>
            </label>
          ))}
        </div>
        {nothingSelected && (
          <div className={styles.error}>{t("viewerExport.error.noWorkspace")}</div>
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>{t("viewerExport.command")}</span>
        <div className={styles.commandRow}>
          <textarea
            ref={commandRef}
            className={styles.command}
            readOnly
            rows={2}
            value={command}
            spellCheck={false}
            data-testid="viewer-export-command"
          />
          <Button
            className={styles.copyButton}
            onClick={copyCommand}
            title={t("viewerExport.copy")}
            data-testid="viewer-export-copy"
          >
            <CopyIcon />
            {t("viewerExport.copy")}
          </Button>
        </div>
        <div className={styles.fileName}>{t("viewerExport.commandHint")}</div>
      </div>

      <div className="dialog-actions">
        <button
          type="button"
          disabled={busy || errorKey !== null || nothingSelected}
          onClick={() => void run()}
          data-testid="viewer-export-run"
        >
          {busy ? t("viewerExport.busy") : t("viewerExport.run")}
        </button>
        <button type="button" onClick={onClose}>
          {t("viewerExport.close")}
        </button>
      </div>
    </Dialog>
  );
}

/** コピー（重なった2枚の紙）。他のアイコンと同じ 24 グリッド・線幅 1.8 で揃える */
function CopyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
