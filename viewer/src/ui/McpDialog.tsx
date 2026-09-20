/**
 * AI 連携（MCP）の設定（Q-01 / 設計書 §8.8）。
 *
 * MCP は既存の Web サーバーに生えたエンドポイント（`POST /__erd/mcp`）であり、
 * ライフサイクルはサーバーと同一である。ここはその**唯一の有効化・トークン発行の窓口**。
 *
 * **トークンの生値は発行の応答でしか受け取れない**（以後サーバーは伏字しか返さない）。
 * そのため設定スニペットに実物を埋められるのは発行直後だけで、それ以外はプレースホルダを
 * 出して「分からなくなったら再発行」と案内する。ここを「いつでも見られる」ようにすると、
 * 画面を開くだけでトークンが漏れる経路を作ることになる。
 *
 * サーバーモード専用（静的モードにはサーバーが居ない）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { cx } from "../lib/cx";
import { MCP_CLIENTS, mcpClient, mcpSnippet, type McpClientId } from "../lib/mcpClients";
import { apiGet, apiPut } from "../model/api";
import { useAppStore } from "../model/store";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import styles from "./McpDialog.module.scss";

interface McpSettings {
  enabled: boolean;
  write: boolean;
  hasToken: boolean;
  tokenHint: string;
  issuedAt: string;
  /** era は MCP の世代（modern / legacy）。接続がうまくいかないときの切り分けに使う */
  lastAccess: { at: string; tool: string; era?: string; write: boolean } | null;
  endpoint: string;
}

export function McpDialog({ onClose }: { onClose: () => void }) {
  const { t, lang } = useI18n();
  const addToast = useAppStore((s) => s.addToast);

  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [busy, setBusy] = useState(false);
  /** 発行直後だけ手元に残る生トークン。リロードすれば消える（サーバーは返さない） */
  const [issued, setIssued] = useState("");
  const [confirmReissue, setConfirmReissue] = useState(false);
  const [client, setClient] = useState<McpClientId>("claude");
  const snippetRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiGet("/__erd/mcp/settings");
        if (!alive) return;
        if (res.status === 200) {
          setSettings(JSON.parse(res.body) as McpSettings);
        } else {
          addToast(t("mcp.loadFailed"), "error");
        }
      } catch {
        if (alive) addToast(t("mcp.loadFailed"), "error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [addToast, t]);

  const update = async (patch: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    try {
      const res = await apiPut("/__erd/mcp/settings", patch);
      if (res.status !== 200) {
        addToast(t("mcp.saveFailed"), "error");
        return;
      }
      const body = JSON.parse(res.body) as McpSettings & { issuedToken?: string };
      setSettings(body);
      if (typeof body.issuedToken === "string") setIssued(body.issuedToken);
    } catch {
      addToast(t("mcp.saveFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const issue = async (): Promise<void> => {
    setConfirmReissue(false);
    await update({ token: "issue" });
    addToast(t("mcp.tokenIssued"));
  };

  const remove = async (): Promise<void> => {
    setIssued("");
    await update({ token: "delete" });
    addToast(t("mcp.tokenDeleted"));
  };

  const snippet = useMemo(
    () =>
      settings === null
        ? ""
        : mcpSnippet(client, settings.endpoint, issued, t("mcp.tokenPlaceholder")),
    [client, settings, issued, t],
  );

  const copySnippet = () => {
    const area = snippetRef.current;
    if (area === null) return;
    area.select();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(snippet).catch(() => document.execCommand("copy"));
    } else {
      document.execCommand("copy");
    }
    addToast(t("mcp.snippetCopied"));
  };

  const lastAccess = (): string => {
    if (settings?.lastAccess == null) return t("mcp.lastAccessNone");
    const at = new Date(settings.lastAccess.at);
    const when = Number.isNaN(at.getTime())
      ? settings.lastAccess.at
      : at.toLocaleString(lang === "ja" ? "ja-JP" : "en-US");
    const era = settings.lastAccess.era;
    return `${when} — ${settings.lastAccess.tool}${era == null ? "" : ` (${era})`}`;
  };

  return (
    <Dialog title={t("mcp.title")} onClose={onClose} size="wide">
      <p className={styles.hint}>{t("mcp.hint")}</p>

      {settings === null ? (
        <p className="muted">{t("mcp.loading")}</p>
      ) : (
        <>
          <div className={styles.field}>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                data-testid="mcp-enabled"
                checked={settings.enabled}
                disabled={busy}
                onChange={(e) => void update({ enabled: e.target.checked })}
              />
              <span className={styles.label}>{t("mcp.enabled")}</span>
            </label>
            <p className={styles.note}>{t("mcp.enabledHint")}</p>
          </div>

          {/* トークン。生値は発行直後にしか出せない（それ以外は末尾数文字のヒントだけ） */}
          <div className={styles.field}>
            <span className={styles.label}>{t("mcp.token")}</span>
            <div className={styles.tokenRow}>
              <span className={styles.tokenState} data-testid="mcp-token-state">
                {settings.hasToken
                  ? t("mcp.tokenPresent", { hint: settings.tokenHint })
                  : t("mcp.tokenAbsent")}
              </span>
              <Button
                variant="primary"
                data-testid="mcp-token-issue"
                disabled={busy}
                onClick={() => (settings.hasToken ? setConfirmReissue(true) : void issue())}
              >
                {settings.hasToken ? t("mcp.tokenReissue") : t("mcp.tokenIssue")}
              </Button>
              {settings.hasToken && (
                <Button variant="danger" disabled={busy} data-testid="mcp-token-delete" onClick={() => void remove()}>
                  {t("mcp.tokenDelete")}
                </Button>
              )}
            </div>
            {issued !== "" && (
              <p className={styles.warn} data-testid="mcp-token-once">
                {t("mcp.tokenOnce")}
              </p>
            )}
          </div>

          {/* 書き込み許可。ここをオンにする操作が唯一の人間ゲートになる（設計書 §8.8） */}
          <div className={styles.field}>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                data-testid="mcp-write"
                checked={settings.write}
                disabled={busy || !settings.enabled}
                onChange={(e) => void update({ write: e.target.checked })}
              />
              <span className={styles.label}>{t("mcp.write")}</span>
            </label>
            <p className={styles.note}>{t("mcp.writeHint")}</p>
            {settings.write && <p className={styles.warn}>{t("mcp.writeCommit")}</p>}
          </div>

          {/* 貼り付ける設定。ポートは起動ごとに変わりうるので、必ずサーバーの値を使う。
              形はクライアントごとに違う（貼り付け先もキーもヘッダの書き方も揃っていない） */}
          <div className={styles.field}>
            <span className={styles.label}>{t("mcp.snippet")}</span>
            <p className={styles.note}>{t("mcp.snippetHint")}</p>
            <div className={styles.tabs} role="tablist" aria-label={t("mcp.snippet")}>
              {MCP_CLIENTS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={client === c.id}
                  className={cx(styles.tab, client === c.id && styles.tabActive)}
                  data-testid={`mcp-client-${c.id}`}
                  onClick={() => setClient(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <p className={styles.note} data-testid="mcp-snippet-where">
              {t("mcp.snippetFile")}: <code>{t(mcpClient(client).whereKey)}</code>
            </p>
            <div className={styles.snippetRow}>
              <textarea
                ref={snippetRef}
                className={styles.snippet}
                data-testid="mcp-snippet"
                readOnly
                rows={9}
                value={snippet}
              />
              <Button className={styles.copyButton} data-testid="mcp-snippet-copy" onClick={copySnippet}>
                {t("mcp.copy")}
              </Button>
            </div>
          </div>

          <div className={styles.field}>
            <span className={styles.label}>{t("mcp.lastAccess")}</span>
            <p className={styles.note} data-testid="mcp-last-access">
              {lastAccess()}
            </p>
          </div>

          <p className={styles.note}>{t("mcp.lifecycleNote")}</p>
        </>
      )}

      <div className="dialog-actions">
        <Button onClick={onClose}>{t("mcp.close")}</Button>
      </div>

      {confirmReissue && (
        <Dialog title={t("mcp.reissueTitle")} onClose={() => setConfirmReissue(false)}>
          <p>{t("mcp.reissueBody")}</p>
          <div className="dialog-actions">
            <Button variant="danger" data-testid="mcp-token-reissue-confirm" onClick={() => void issue()}>
              {t("mcp.tokenReissue")}
            </Button>
            <Button onClick={() => setConfirmReissue(false)}>{t("layout.cancel")}</Button>
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}
