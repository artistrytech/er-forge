/**
 * DB からの逆生成 `#/introspect`（K-01〜K-15）。
 *
 * 接続 → 対象の選択 → 差分プレビュー → リネームの判断 → 適用範囲の選択 → 適用。
 * <b>プレビューと適用の間、サーバーは1バイトも書かない</b>（INV-4）。ユーザーがツリーを
 * 展開したりリネームを訂正している間、サーバーは内省結果のスナップショットを持っているだけで
 * DB にも再接続しない。
 */
import { useEffect, useMemo, useState } from "react";
import type { MsgKey } from "../i18n/messages";
import { useI18n } from "../i18n/useI18n";
import { apiGet, apiPost, apiPut } from "../model/api";
import { currentLockId, notifyLockLost, rememberOwnRevision } from "../model/editStore";
import { loadConfig, reloadAfterApply } from "../model/loader";
import { useAppStore } from "../model/store";
import { Dialog } from "../ui/Dialog";
import { EditSessionGate, useFormSessionReady } from "../ui/EditSessionGate";
import { Link } from "../ui/Link";
import { hrefs } from "../ui/router";
import { DiffTree } from "./DiffTree";
import { affectedFileCount, defaultSelection, quickSelect, toggle } from "./selection";
import type {
  ApplyResponse,
  ConnectionTest,
  Decision,
  DriverInfo,
  Preview,
  RenameDecision,
} from "./types";

/** K-03: 既知ドライバの URL テンプレート（MySQL は useInformationSchema を既定で含む。§7.4） */
const TEMPLATES: { label: string; url: string }[] = [
  { label: "PostgreSQL", url: "jdbc:postgresql://localhost:5432/mydb" },
  { label: "MySQL", url: "jdbc:mysql://localhost:3306/mydb?useInformationSchema=true" },
  { label: "SQL Server", url: "jdbc:sqlserver://localhost:1433;databaseName=mydb" },
  { label: "H2", url: "jdbc:h2:./mydb" },
];

type Step = "connect" | "preview" | "done";

export function IntrospectPage() {
  const { t } = useI18n();
  const addToast = useAppStore((s) => s.addToast);
  const config = useAppStore((s) => s.config);
  const sessionReady = useFormSessionReady();

  const [step, setStep] = useState<Step>("connect");
  const [drivers, setDrivers] = useState<DriverInfo[]>([]);
  const [url, setUrl] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [savePassword, setSavePassword] = useState(false);
  const [namespace, setNamespace] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [ignoreText, setIgnoreText] = useState("");
  const [ignoreHash, setIgnoreHash] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, RenameDecision>>({});
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [confirmGuard, setConfirmGuard] = useState(false);
  const [result, setResult] = useState<ApplyResponse | null>(null);

  // 起動時: ドライバ一覧（K-01）・保存済み接続（K-05）・無視リスト（K-15）
  useEffect(() => {
    void apiGet("/__erd/drivers").then((res) => {
      if (res.status === 200) setDrivers((JSON.parse(res.body) as { drivers: DriverInfo[] }).drivers);
    });
    void apiGet("/__erd/connection").then((res) => {
      if (res.status !== 200) return;
      const saved = JSON.parse(res.body) as {
        saved: boolean;
        url?: string;
        user?: string;
        password?: string;
        namespace?: string;
        savePassword?: boolean;
      };
      if (!saved.saved) return;
      setUrl(saved.url ?? "");
      setUser(saved.user ?? "");
      setPassword(saved.password ?? "");
      setNamespace(saved.namespace ?? "");
      setSavePassword(saved.savePassword ?? false);
    });
    void apiGet("/__erd/config").then((res) => {
      if (res.status === 200) {
        setIgnoreHash((JSON.parse(res.body) as { baseHash: string | null }).baseHash);
      }
    });
    void loadConfig();
  }, []);

  useEffect(() => {
    setIgnoreText((config?.ignoreTables ?? []).join("\n"));
  }, [config]);

  const connection = useMemo(
    () => ({ url, user, password }),
    [url, user, password],
  );

  const scope = useMemo(
    () => ({
      namespace,
      include: include.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== ""),
      exclude: exclude.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== ""),
    }),
    [namespace, include, exclude],
  );

  // ---- K-04: 接続テスト ----
  const runTest = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost("/__erd/connection/test", { connection });
      if (res.status === 200) {
        const body = JSON.parse(res.body) as ConnectionTest;
        setTest(body);
        if (namespace === "" && body.namespaces.length > 0) setNamespace(body.namespaces[0]!);
      } else {
        setError((JSON.parse(res.body) as { message: string }).message);
      }
    } catch {
      setError(t("introspect.networkError"));
    } finally {
      setBusy(false);
    }
  };

  // ---- K-05: 接続情報の保存（パスワードは明示的オプトイン） ----
  const saveConnection = async () => {
    await apiPut("/__erd/connection", {
      url,
      user,
      password,
      savePassword,
      namespace,
    });
    addToast(t("introspect.connectionSaved"));
  };

  // ---- K-07 → K-08: 逆生成の実行 ----
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost("/__erd/introspect", { connection, scope });
      if (res.status === 200) {
        const body = JSON.parse(res.body) as Preview;
        setPreview(body);
        setDecisions({});
        setSelection(defaultSelection(body.items));
        setStep("preview");
      } else {
        setError((JSON.parse(res.body) as { message: string }).message);
      }
    } catch {
      setError(t("introspect.networkError"));
    } finally {
      setBusy(false);
    }
  };

  // ---- K-09: リネームの判断（決定が変わるたびにサーバーでプランを再計算する） ----
  const decide = async (id: string, decision: Decision, to?: string) => {
    if (!preview) return;
    const next = { ...decisions, [id]: { id, decision, ...(to !== undefined ? { to } : {}) } };
    setDecisions(next);
    setBusy(true);
    try {
      const res = await apiPost(`/__erd/introspect/${preview.sessionId}/plan`, {
        renameDecisions: Object.values(next),
      });
      if (res.status === 200) {
        const body = JSON.parse(res.body) as Preview;
        setPreview(body);
        setSelection(defaultSelection(body.items));
      } else if (res.status === 410) {
        expired();
      }
    } finally {
      setBusy(false);
    }
  };

  const expired = () => {
    setStep("connect");
    setPreview(null);
    setError(t("introspect.sessionExpired"));
  };

  // ---- K-11: 適用 ----
  const apply = async (confirmed: boolean) => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setConfirmGuard(false);
    try {
      const res = await apiPost("/__erd/introspect/apply", {
        lockId: currentLockId(),
        sessionId: preview.sessionId,
        baseFingerprint: preview.baseFingerprint,
        selection: [...selection],
        renameDecisions: Object.values(decisions),
        confirmed,
      });
      if (res.status === 200) {
        const body = JSON.parse(res.body) as ApplyResponse;
        rememberOwnRevision(body.revision);
        if (useAppStore.getState().manifest === null) {
          // 空プロジェクトからの初期化（§3.6）。読み込み経路をやり直す
          location.reload();
          return;
        }
        await reloadAfterApply(body.revision);
        setResult(body);
        setStep("done");
        return;
      }
      const body = JSON.parse(res.body) as { code?: string; message?: string };
      if (res.status === 410) {
        expired();
      } else if (res.status === 423) {
        notifyLockLost();
      } else if (res.status === 400 && body.code === "GUARD") {
        setConfirmGuard(true);
      } else if (res.status === 409) {
        setError(t("introspect.staleFingerprint"));
      } else {
        setError(body.message ?? `HTTP ${res.status}`);
      }
    } catch {
      setError(t("introspect.networkError"));
    } finally {
      setBusy(false);
    }
  };

  // ---- K-15: 無視リストの保存（差分プレビューの削除項目からのショートカットを含む） ----
  const saveIgnore = async (patterns: string[]) => {
    const res = await apiPut("/__erd/config", {
      lockId: currentLockId(),
      baseHash: ignoreHash,
      ignoreTables: patterns,
    });
    if (res.status === 200) {
      const body = JSON.parse(res.body) as { revision: string; newHash: string };
      rememberOwnRevision(body.revision);
      setIgnoreHash(body.newHash);
      await loadConfig(body.revision);
      addToast(t("introspect.ignoreSaved"));
      return true;
    }
    if (res.status === 423) notifyLockLost();
    else setError(`${t("save.failed")} (HTTP ${res.status})`);
    return false;
  };

  /** 削除項目の「無視リストに追加」（§8.4）。config.js を書き換えるため、そのまま再プレビューする */
  const ignoreTable = async (tableId: string) => {
    const patterns = [...(config?.ignoreTables ?? [])];
    if (!patterns.includes(tableId)) patterns.push(tableId);
    setIgnoreText(patterns.join("\n"));
    if (await saveIgnore(patterns)) {
      await run();
    }
  };

  const undecided = (preview?.renameCandidates ?? []).filter((c) => decisions[c.id] === undefined);

  if (step === "done" && result !== null) {
    return <ApplyResult result={result} onRestart={() => setStep("connect")} />;
  }

  return (
    <div className="catalog-page introspect-page">
      <div className="catalog-header">
        <h2>{t("introspect.title")}</h2>
      </div>
      <p className="muted form-hint">{t("introspect.hint")}</p>

      <EditSessionGate />
      {error !== null && <div className="error-banner">{error}</div>}

      {step === "connect" && (
        <>
          <section className="form-section">
            <h3>{t("introspect.connection")}</h3>
            <div className="form-row">
              <label htmlFor="jdbc-url">{t("introspect.url")}</label>
              <input
                id="jdbc-url"
                type="text"
                className="mono"
                data-testid="jdbc-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={TEMPLATES[0]!.url}
              />
            </div>
            <div className="form-row">
              <span className="muted">{t("introspect.templates")}</span>
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.label}
                  type="button"
                  className="link-button"
                  onClick={() => setUrl(tpl.url)}
                >
                  {tpl.label}
                </button>
              ))}
            </div>
            <div className="form-row">
              <label htmlFor="jdbc-user">{t("introspect.user")}</label>
              <input
                id="jdbc-user"
                type="text"
                value={user}
                onChange={(e) => setUser(e.target.value)}
              />
              <label htmlFor="jdbc-password">{t("introspect.password")}</label>
              <input
                id="jdbc-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={savePassword}
                  onChange={(e) => setSavePassword(e.target.checked)}
                />
                {t("introspect.savePassword")}
              </label>
              <button type="button" className="header-button" onClick={() => void saveConnection()}>
                {t("introspect.saveConnection")}
              </button>
              <span className="spacer" />
              <button
                type="button"
                className="header-button"
                disabled={busy || url === ""}
                data-testid="test-connection"
                onClick={() => void runTest()}
              >
                {t("introspect.test")}
              </button>
            </div>
            {test !== null && (
              <p className="notice-banner" data-testid="test-result">
                {test.product} {test.version} / {test.driver}
              </p>
            )}
          </section>

          <section className="form-section">
            <h3>{t("introspect.scope")}</h3>
            <div className="form-row">
              <label htmlFor="namespace">{t("introspect.namespace")}</label>
              {test !== null && test.namespaces.length > 0 ? (
                <select
                  id="namespace"
                  data-testid="namespace"
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                >
                  {test.namespaces.map((ns) => (
                    <option key={ns} value={ns}>
                      {ns}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="namespace"
                  type="text"
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                />
              )}
              <span className="muted">{t("introspect.namespaceHint")}</span>
            </div>
            <div className="form-row">
              <label htmlFor="include">{t("introspect.include")}</label>
              <input
                id="include"
                type="text"
                className="mono"
                value={include}
                onChange={(e) => setInclude(e.target.value)}
                placeholder="*"
              />
              <label htmlFor="exclude">{t("introspect.exclude")}</label>
              <input
                id="exclude"
                type="text"
                className="mono"
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
                placeholder="tmp_*"
              />
            </div>
            <p className="muted">{t("introspect.filterHint")}</p>
          </section>

          <IgnoreList
            text={ignoreText}
            onChange={setIgnoreText}
            disabled={!sessionReady}
            onSave={() =>
              void saveIgnore(
                ignoreText.split("\n").map((s) => s.trim()).filter((s) => s !== ""),
              )
            }
          />

          <section className="form-section">
            <h3>{t("introspect.drivers")}</h3>
            <ul className="driver-list">
              {drivers.map((d) => (
                <li key={d.className} className="mono">
                  {d.className} <span className="muted">{d.version}</span>{" "}
                  <span className="badge">{d.source}</span>
                </li>
              ))}
              {drivers.length === 0 && <li className="muted">{t("introspect.noDrivers")}</li>}
            </ul>
          </section>

          <div className="form-actions">
            <button
              type="button"
              className="header-button header-button-primary"
              disabled={busy || url === "" || namespace === "" || !sessionReady}
              data-testid="run-introspect"
              onClick={() => void run()}
            >
              {busy ? t("introspect.running") : t("introspect.run")}
            </button>
          </div>
        </>
      )}

      {step === "preview" && preview !== null && (
        <>
          <Stats preview={preview} />

          {preview.guards.map((g) => (
            <div key={g.code} className="error-banner">
              ⚠ {g.message}
            </div>
          ))}
          {preview.warnings.map((w, i) => (
            <div key={i} className="notice-banner">
              {w}
            </div>
          ))}

          {preview.renameCandidates.length > 0 && (
            <section className="form-section">
              <h3>
                {t("introspect.renames")} ({preview.renameCandidates.length})
              </h3>
              {preview.renameCandidates.map((c) => (
                <RenameRow
                  key={c.id}
                  candidate={c}
                  decision={decisions[c.id]}
                  onDecide={(d, to) => void decide(c.id, d, to)}
                />
              ))}
              {undecided.length > 0 && (
                <p className="diff-warn">
                  ⚠ {t("introspect.undecided", { n: undecided.length })}
                </p>
              )}
            </section>
          )}

          <div className="columns-toolbar">
            <button
              type="button"
              className="header-button"
              onClick={() => setSelection(quickSelect(preview.items, "all"))}
            >
              {t("introspect.selectAll")}
            </button>
            <button
              type="button"
              className="header-button"
              onClick={() => setSelection(quickSelect(preview.items, "none"))}
            >
              {t("introspect.selectNone")}
            </button>
            <button
              type="button"
              className="header-button"
              onClick={() => setSelection(quickSelect(preview.items, "addedOnly"))}
            >
              {t("introspect.selectAdded")}
            </button>
            <button
              type="button"
              className="header-button"
              onClick={() => setSelection(quickSelect(preview.items, "withoutRemoved"))}
            >
              {t("introspect.selectWithoutRemoved")}
            </button>
          </div>

          <DiffTree
            items={preview.items}
            selection={selection}
            onToggle={(id) => setSelection(toggle(preview.items, selection, id))}
            onIgnore={(id) => void ignoreTable(id)}
          />

          {preview.items.length === 0 && (
            <p className="empty-state">{t("introspect.noChanges")}</p>
          )}

          <IgnoredList preview={preview} />

          <div className="form-actions sticky-actions">
            <span className="muted">
              {t("introspect.selected", {
                n: selection.size,
                files: affectedFileCount(preview.items, selection),
              })}
            </span>
            <span className="spacer" />
            <button type="button" className="header-button" onClick={() => setStep("connect")}>
              {t("introspect.back")}
            </button>
            <button
              type="button"
              className="header-button header-button-primary"
              data-testid="apply"
              disabled={busy || !sessionReady || undecided.length > 0 || preview.items.length === 0}
              onClick={() => void apply(false)}
            >
              {busy ? t("introspect.applying") : t("introspect.apply")}
            </button>
          </div>
        </>
      )}

      {confirmGuard && preview !== null && (
        <Dialog title={t("introspect.guardTitle")} onClose={() => setConfirmGuard(false)}>
          {preview.guards.map((g) => (
            <p key={g.code}>⚠ {g.message}</p>
          ))}
          <p>{t("introspect.guardBody")}</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setConfirmGuard(false)}>
              {t("dialog.cancel")}
            </button>
            <button type="button" className="danger" onClick={() => void apply(true)}>
              {t("introspect.applyAnyway")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Stats({ preview }: { preview: Preview }) {
  const { t } = useI18n();
  const s = preview.stats;
  return (
    <div className="introspect-stats" data-testid="stats">
      <span className="badge">{preview.source.product} {preview.source.version}</span>
      <span>{t("introspect.change.added")}: {s.added}</span>
      <span>{t("introspect.change.renamed")}: {s.renamed}</span>
      <span>{t("introspect.change.modified")}: {s.modified}</span>
      <span>{t("introspect.change.removed")}: {s.removed}</span>
      <span className="muted">{t("introspect.unchanged", { n: s.unchanged })}</span>
      <span className="muted">{t("introspect.ignoredCount", { n: s.ignored })}</span>
      <span className="muted">{t("introspect.outOfScope", { n: s.outOfScope })}</span>
    </div>
  );
}

function RenameRow({
  candidate,
  decision,
  onDecide,
}: {
  candidate: Preview["renameCandidates"][number];
  decision: RenameDecision | undefined;
  onDecide: (decision: Decision, to?: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className={`rename-row rename-${decision?.decision ?? "undecided"}`}>
      <span className="mono">
        {candidate.from} → {candidate.to}
      </span>
      <span className={`badge badge-${candidate.confidence}`}>
        {t(`introspect.confidence.${candidate.confidence}` as MsgKey)} ({candidate.score})
      </span>
      <span className="muted">{t(`introspect.reason.${candidate.reason}` as MsgKey)}</span>
      <span className="spacer" />
      {candidate.alternatives.length > 0 && (
        <select
          value={decision?.to ?? candidate.to}
          onChange={(e) => onDecide("correct", e.target.value)}
        >
          {[candidate.to, ...candidate.alternatives].map((to) => (
            <option key={to} value={to}>
              {to}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className={"header-button" + (decision?.decision === "accept" ? " header-button-primary" : "")}
        onClick={() => onDecide("accept")}
      >
        {t("introspect.accept")}
      </button>
      <button
        type="button"
        className={"header-button" + (decision?.decision === "reject" ? " danger" : "")}
        title={t("introspect.rejectHint")}
        onClick={() => onDecide("reject")}
      >
        {t("introspect.reject")}
      </button>
    </div>
  );
}

function IgnoredList({ preview }: { preview: Preview }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (preview.ignored.length === 0) return null;
  return (
    <section className="form-section">
      <button type="button" className="link-button" onClick={() => setOpen(!open)}>
        {open ? "▼" : "▸"} {t("introspect.ignoredCount", { n: preview.ignored.length })}
      </button>
      {open && (
        <ul className="driver-list">
          {preview.ignored.map((i) => (
            <li key={i.tableId} className="mono">
              {i.tableId} <span className="muted">← {i.matchedBy}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function IgnoreList({
  text,
  onChange,
  onSave,
  disabled,
}: {
  text: string;
  onChange: (value: string) => void;
  onSave: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <section className="form-section">
      <h3>{t("introspect.ignoreList")}</h3>
      <p className="muted">{t("introspect.ignoreListHint")}</p>
      <textarea
        className="paste-area mono"
        rows={4}
        value={text}
        disabled={disabled}
        data-testid="ignore-list"
        onChange={(e) => onChange(e.target.value)}
        placeholder={"public.flyway_schema_history\npublic.tmp_*\n/^staging\\..*_bak$/"}
      />
      <div className="form-actions">
        <button type="button" className="header-button" disabled={disabled} onClick={onSave}>
          {t("introspect.ignoreSave")}
        </button>
      </div>
    </section>
  );
}

/** 適用後（K-12 / K-13）: 未配置テーブルと孤児ノードを次の操作へつなぐ */
function ApplyResult({ result, onRestart }: { result: ApplyResponse; onRestart: () => void }) {
  const { t } = useI18n();
  const a = result.applied;
  return (
    <div className="catalog-page introspect-page">
      <div className="catalog-header">
        <h2>{t("introspect.doneTitle")}</h2>
      </div>
      <div className="introspect-stats" data-testid="apply-result">
        <span>{t("introspect.change.added")}: {a.added}</span>
        <span>{t("introspect.change.renamed")}: {a.renamed}</span>
        <span>{t("introspect.change.modified")}: {a.modified}</span>
        <span>{t("introspect.change.removed")}: {a.removed}</span>
        <span className="muted">
          {t("introspect.seeded", {
            tables: result.logicalNamesSeeded.tables,
            columns: result.logicalNamesSeeded.columns,
          })}
        </span>
      </div>

      {result.skipped.count > 0 && (
        <div className="notice-banner">
          {t("introspect.skipped", { n: result.skipped.count })}
        </div>
      )}

      {result.unplacedTables.length > 0 && (
        <section className="form-section">
          <h3>{t("introspect.unplaced")}</h3>
          <p className="muted">{t("introspect.unplacedHint")}</p>
          <ul className="driver-list">
            {result.unplacedTables.map((id) => (
              <li key={id}>
                <Link href={hrefs.table(id)}>{id}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.orphanNodes.length > 0 && (
        <section className="form-section">
          <h3>{t("introspect.orphans")}</h3>
          <p className="muted">{t("introspect.orphansHint")}</p>
          <ul className="driver-list">
            {result.orphanNodes.map((o) => (
              <li key={o.tableId} className="mono">
                {o.tableId}{" "}
                <span className="muted">
                  {o.diagrams.map((d) => (
                    <Link key={d} href={hrefs.erd(d)}>
                      {d}{" "}
                    </Link>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.warnings.map((w, i) => (
        <div key={i} className="notice-banner">
          ⚠ {w.message}
        </div>
      ))}

      <div className="form-actions">
        <Link className="button-link" href={hrefs.tables()}>
          {t("notFound.toTables")}
        </Link>
        <button type="button" className="header-button" onClick={onRestart}>
          {t("introspect.again")}
        </button>
      </div>
    </div>
  );
}
