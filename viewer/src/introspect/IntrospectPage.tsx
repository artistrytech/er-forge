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
import { rememberOwnRevision } from "../model/editStore";
import { loadConfig, reloadAfterApply } from "../model/loader";
import { useAppStore } from "../model/store";
import { Dialog } from "../ui/Dialog";
import { Link } from "../ui/Link";
import { hrefs } from "../ui/router";
import { DiffTree } from "./DiffTree";
import { DriverGate, type GateSelection } from "./DriverGate";
import { DriverSetup, type DriverSelection } from "./DriverSetup";
import { affectedFileCount, defaultSelection, quickSelect, toggle } from "./selection";
import type {
  ApplyResponse,
  ConnectionTest,
  Decision,
  DriverCatalogEntry,
  DriverDownloadResult,
  DriversResponse,
  Preview,
  RenameDecision,
} from "./types";
import { cx } from "../lib/cx";
import styles from "./IntrospectPage.module.scss";

// 動的 `rename-${decision}` は camelCaseOnly で kebab キーが消えるため明示マップにする
const RENAME_CLASS: Record<string, string | undefined> = {
  undecided: styles.renameUndecided,
  reject: styles.renameReject,
};

/** JDBC URL のサブプロトコル → カタログ ID。接続失敗時に「必要なドライバ」を当てるのに使う。 */
const SUBPROTOCOL_TO_CATALOG: Record<string, string> = {
  postgresql: "postgresql",
  postgres: "postgresql",
  mysql: "mysql",
  mariadb: "mysql",
  sqlserver: "sqlserver",
  jtds: "sqlserver",
  oracle: "oracle",
  sqlite: "sqlite",
  h2: "h2",
};

/** jdbc:postgresql://... → カタログの PostgreSQL エントリ。判定できなければ null。 */
function detectDriver(url: string, catalog: DriverCatalogEntry[]): DriverCatalogEntry | null {
  const m = /^jdbc:([a-z0-9]+):/i.exec(url.trim());
  if (!m) return null;
  const id = SUBPROTOCOL_TO_CATALOG[m[1]!.toLowerCase()];
  return id ? catalog.find((e) => e.id === id) ?? null : null;
}

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
  // 逆生成は編集ルート相当（サーバー専用。App が serverMode のときのみ描画する）。
  // ロックは無いため、サーバーモードであれば操作可能（§2.3）
  const sessionReady = useAppStore((s) => s.serverMode === true);

  const [step, setStep] = useState<Step>("connect");
  const [driversResp, setDriversResp] = useState<DriversResponse | null>(null);
  const [downloading, setDownloading] = useState(false);
  // 接続失敗が「ドライバ未取得」由来のとき、その場で取得できるように対象を保持する
  const [neededDriver, setNeededDriver] = useState<DriverCatalogEntry | null>(null);

  // ドライバが整っていなければ逆生成画面をモーダルで塞ぐ（§7.2）。
  //  - missing あり（config 宣言済みで未取得）→ ダウンロードの確認のみ
  //  - ドライバも設定も無い          → 使う DB を選ばせる初期設定
  const gate: "none" | "setup" | "confirm" = useMemo(() => {
    if (driversResp === null) return "none";
    if (driversResp.missing.length > 0) return "confirm";
    if (driversResp.drivers.length === 0 && driversResp.configured.artifacts.length === 0) {
      return "setup";
    }
    return "none";
  }, [driversResp]);
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

  // エラーはバナー表示に加えてトースト通知も出す（画面のどこを見ていても気づけるように）
  const fail = (msg: string) => {
    setError(msg);
    addToast(msg, "error");
  };

  // 接続失敗の共通処理。ドライバ未取得が原因なら、その場で取得する導線（neededDriver）を出す
  const handleConnectError = (body: { code?: string; message?: string }) => {
    const msg = body.message ?? t("introspect.networkError");
    if (body.code === "CONNECT_FAILED" && /no suitable driver/i.test(msg)) {
      const entry = driversResp ? detectDriver(url, driversResp.catalog) : null;
      if (entry) {
        setNeededDriver(entry);
        fail(t("introspect.driverMissingForUrl", { db: entry.label }));
        return;
      }
    }
    setNeededDriver(null);
    fail(msg);
  };

  // §7.2: ロード済み・カタログ・config.js のドライバ設定・未取得の一覧をまとめて取得する
  const fetchDrivers = async (): Promise<DriversResponse | null> => {
    const res = await apiGet("/__erd/drivers");
    if (res.status !== 200) return null;
    const body = JSON.parse(res.body) as DriversResponse;
    setDriversResp(body);
    return body;
  };

  // ドライバ設定を config.js（Git 管理・共有）へ保存する。無視リストと同じ baseHash を使う
  const saveDrivers = async (selection: DriverSelection) => {
    const res = await apiPut("/__erd/config", {
      baseHash: ignoreHash,
      drivers: selection,
    });
    if (res.status === 200) {
      const body = JSON.parse(res.body) as { revision: string; newHash: string };
      rememberOwnRevision(body.revision);
      setIgnoreHash(body.newHash);
      await loadConfig(body.revision);
      await fetchDrivers();
      addToast(t("introspect.driversSaved"));
    } else if (res.status === 409) {
      fail(t("introspect.staleFingerprint"));
    } else {
      fail((JSON.parse(res.body) as { error?: string }).error ?? `HTTP ${res.status}`);
    }
  };

  // 初期設定モーダル: 選んだドライバを config.js に保存（チーム共有）→ ダウンロード＋登録
  const setupAndDownload = async (sel: GateSelection) => {
    setDownloading(true);
    setError(null);
    try {
      const putRes = await apiPut("/__erd/config", { baseHash: ignoreHash, drivers: sel });
      if (putRes.status === 409) {
        fail(t("introspect.staleFingerprint"));
        return;
      }
      if (putRes.status !== 200) {
        fail((JSON.parse(putRes.body) as { error?: string }).error ?? `HTTP ${putRes.status}`);
        return;
      }
      const b = JSON.parse(putRes.body) as { revision: string; newHash: string };
      rememberOwnRevision(b.revision);
      setIgnoreHash(b.newHash);
      await loadConfig(b.revision);
      await downloadDrivers(sel.artifacts, sel.mavenRepository);
    } catch {
      fail(t("introspect.networkError"));
    } finally {
      setDownloading(false);
    }
  };

  // モーダルの「逆生成をやめる」: 逆生成画面を出る（他画面へ退避。ブロックはしない）
  const leaveIntrospect = () => {
    window.location.hash = hrefs.tables();
  };

  // 接続失敗画面からの「このドライバを取得」: config.js に追加保存（チーム共有）→ ダウンロード＋登録
  const getDriverNow = async (entry: DriverCatalogEntry) => {
    setDownloading(true);
    setError(null);
    try {
      const artifacts = [...(driversResp?.configured.artifacts ?? [])];
      if (!artifacts.includes(entry.coordinate)) artifacts.push(entry.coordinate);
      const putRes = await apiPut("/__erd/config", {
        baseHash: ignoreHash,
        drivers: { mavenRepository: driversResp?.configured.mavenRepository, artifacts },
      });
      if (putRes.status === 200) {
        const b = JSON.parse(putRes.body) as { revision: string; newHash: string };
        rememberOwnRevision(b.revision);
        setIgnoreHash(b.newHash);
        await loadConfig(b.revision);
      } else if (putRes.status === 409) {
        fail(t("introspect.staleFingerprint"));
        return;
      }
      const res = await apiPost("/__erd/drivers/download", {
        mavenRepository: driversResp?.configured.mavenRepository,
        artifacts: [entry.coordinate],
      });
      if (res.status === 200) {
        const b = JSON.parse(res.body) as { results: DriverDownloadResult[] };
        const r = b.results[0];
        await fetchDrivers();
        if (r && r.ok) {
          setNeededDriver(null);
          setError(null);
          addToast(t("introspect.driverReady", { db: entry.label }));
        } else {
          fail(r?.message ?? t("introspect.driversDownloadFailed", { n: 1 }));
        }
      } else {
        fail((JSON.parse(res.body) as { error?: string }).error ?? `HTTP ${res.status}`);
      }
    } catch {
      fail(t("introspect.networkError"));
    } finally {
      setDownloading(false);
    }
  };

  // Maven からダウンロードして drivers/ に置く（外部通信。確認済みの対象のみ）
  const downloadDrivers = async (artifacts: string[], repository?: string) => {
    setDownloading(true);
    setError(null);
    try {
      const res = await apiPost("/__erd/drivers/download", {
        mavenRepository: repository ?? driversResp?.configured.mavenRepository,
        artifacts,
      });
      if (res.status === 200) {
        const body = JSON.parse(res.body) as { results: DriverDownloadResult[] };
        await fetchDrivers();
        const failures = body.results.filter((r) => !r.ok);
        if (failures.length === 0) {
          addToast(t("introspect.driversDownloaded", { n: body.results.length }));
        } else {
          // 失敗した座標と理由を通知に含める（ダイアログ内でも error バナーに出る）
          fail(
            `${t("introspect.driversDownloadFailed", { n: failures.length })}: ` +
              failures.map((r) => `${r.coordinate}${r.message ? ` (${r.message})` : ""}`).join(", "),
          );
        }
      } else {
        fail((JSON.parse(res.body) as { error?: string }).error ?? `HTTP ${res.status}`);
      }
    } catch {
      fail(t("introspect.networkError"));
    } finally {
      setDownloading(false);
    }
  };

  // 起動時: ドライバ設定（K-01 / §7.2）・保存済み接続（K-05）・無視リスト（K-15）。
  // ドライバの整備状況は fetchDrivers → gate（useMemo）で判定し、必要ならモーダルで塞ぐ
  useEffect(() => {
    void fetchDrivers();
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
        setNeededDriver(null);
        if (namespace === "" && body.namespaces.length > 0) setNamespace(body.namespaces[0]!);
      } else {
        handleConnectError(JSON.parse(res.body) as { code?: string; message?: string });
      }
    } catch {
      fail(t("introspect.networkError"));
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
        setNeededDriver(null);
        setDecisions({});
        setSelection(defaultSelection(body.items));
        setStep("preview");
      } else {
        handleConnectError(JSON.parse(res.body) as { code?: string; message?: string });
      }
    } catch {
      fail(t("introspect.networkError"));
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
    fail(t("introspect.sessionExpired"));
  };

  // ---- K-11: 適用 ----
  const apply = async (confirmed: boolean) => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setConfirmGuard(false);
    try {
      const res = await apiPost("/__erd/introspect/apply", {
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
        // K-12 §7.2: 今回の新規テーブルを未配置トレイで「NEW」として先頭に寄せる。
        // セッション限定のメモリ状態であり、リロードで消える（ファイルには残さない）
        useAppStore.getState().setRecentTables(body.unplacedTables);
        setResult(body);
        setStep("done");
        return;
      }
      const body = JSON.parse(res.body) as { code?: string; message?: string };
      if (res.status === 410) {
        expired();
      } else if (res.status === 400 && body.code === "GUARD") {
        setConfirmGuard(true);
      } else if (res.status === 409) {
        fail(t("introspect.staleFingerprint"));
      } else {
        fail(body.message ?? `HTTP ${res.status}`);
      }
    } catch {
      fail(t("introspect.networkError"));
    } finally {
      setBusy(false);
    }
  };

  // ---- K-15: 無視リストの保存（差分プレビューの削除項目からのショートカットを含む） ----
  const saveIgnore = async (patterns: string[]) => {
    const res = await apiPut("/__erd/config", {
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
    fail(`${t("save.failed")} (HTTP ${res.status})`);
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
    <div className={cx("catalog-page", styles.introspectPage)} data-testid="introspect-page">
      <div className="catalog-header">
        <h2>{t("introspect.title")}</h2>
      </div>
      <p className="muted form-hint">{t("introspect.hint")}</p>

      {error !== null && <div className="error-banner">{error}</div>}

      {neededDriver !== null && (
        <div className={cx("notice-banner", styles.driverNeeded)} data-testid="driver-needed">
          <span>{t("introspect.driverMissingForUrl", { db: neededDriver.label })}</span>
          <button
            type="button"
            className="header-button header-button-primary"
            disabled={downloading || !sessionReady}
            data-testid="get-driver"
            onClick={() => void getDriverNow(neededDriver)}
          >
            {downloading
              ? t("introspect.driversDownloading")
              : t("introspect.getDriver", { db: neededDriver.label })}
          </button>
        </div>
      )}

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
              <label className={styles.checkboxLabel}>
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

          {driversResp !== null && (
            <DriverSetup
              loaded={driversResp.drivers}
              catalog={driversResp.catalog}
              configured={driversResp.configured}
              missing={driversResp.missing}
              disabled={!sessionReady}
              busy={downloading}
              onSave={(sel) => void saveDrivers(sel)}
              onDownload={(arts) => void downloadDrivers(arts)}
            />
          )}

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

          <div className={cx("form-actions", styles.stickyActions)}>
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

      {gate !== "none" && driversResp !== null && (
        <DriverGate
          mode={gate}
          catalog={driversResp.catalog}
          configured={driversResp.configured}
          missing={driversResp.missing}
          busy={downloading}
          error={error}
          disabled={!sessionReady}
          onConfirmDownload={() => void downloadDrivers(driversResp.missing)}
          onSetupAndDownload={(sel) => void setupAndDownload(sel)}
          onLeave={leaveIntrospect}
        />
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
    <div className={styles.introspectStats} data-testid="stats">
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
    <div className={cx(styles.renameRow, RENAME_CLASS[decision?.decision ?? "undecided"])}>
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
  // 逆生成は diagrams/** を書き換えないため、初回はページが0件になる。
  // その場合は #/erd（ページ作成の導線）へ送る。ここで行き止まりにしない
  const firstDiagram = useAppStore((s) => s.manifest?.diagrams?.[0]?.id);
  const placementHref = firstDiagram !== undefined ? hrefs.erd(firstDiagram) : hrefs.erdHome();
  return (
    <div className={cx("catalog-page", styles.introspectPage)} data-testid="introspect-page">
      <div className="catalog-header">
        <h2>{t("introspect.doneTitle")}</h2>
      </div>
      <div className={styles.introspectStats} data-testid="apply-result">
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
          {/* K-12: 配置操作へ誘導する。ページが1枚も無ければ #/erd が作成の導線を出す */}
          <p>
            <Link className="button-link" data-testid="to-placement" href={placementHref}>
              {t("introspect.toPlacement")}
            </Link>
          </p>
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
