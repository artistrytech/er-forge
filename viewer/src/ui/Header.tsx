/**
 * ヘッダ（A-02 / A-03 / L-04 / P-05）。
 * 右側は「ツール」「information（ⓘ）」「設定（歯車）」だけを置く。
 * 動作モードは information の中に文字で置く（常時表示のアイコンは廃止した）。
 * **編集操作（編集開始・保存・保存して終了・編集終了）はヘッダには置かない。**
 * 編集は「いま見ている内容」に対する操作なので、画面の右下に浮かせている（ui/EditControls.tsx）。
 */
import { useEffect, useRef, useState } from "react";
import appIconUrl from "../assets/app-icon.png";
import { useI18n } from "../i18n/useI18n";
import { apiPatch, apiPost, wpath } from "../model/api";
import { loadAllTables } from "../model/loader";
import type { NameDisplay } from "../model/logicalName";
import {
  buildSchemaExport,
  schemaExportFileName,
  serializeSchemaExport,
} from "../model/schemaExport";
import { queueToastAfterReload, totalTableCount, useAppStore } from "../model/store";
import { isValidWorkspaceId, type WorkspaceRef } from "../model/workspace";
import type { Lang } from "../i18n/messages";
import { cx } from "../lib/cx";
import { downloadText } from "../lib/download";
import { AboutDialog } from "./AboutDialog";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { McpDialog } from "./McpDialog";
import { ViewerExportDialog } from "./ViewerExportDialog";
import { Link } from "./Link";
import { hrefs, useRoute } from "./router";
import { useDropdown } from "./useDropdown";
import { WorkspaceDeleteDialog, WorkspaceMenu } from "./Workspace";
import { APP_VERSION } from "../version";
import styles from "./Header.module.scss";

/** 表示中のワークスペース（workspaces.js の一覧から引く） */
function useCurrentWorkspace(): WorkspaceRef | null {
  const workspaces = useAppStore((s) => s.workspaces);
  const workspaceId = useAppStore((s) => s.workspaceId);
  return workspaces.find((w) => w.id === workspaceId) ?? null;
}

export function Header({ currentDiagramId }: { currentDiagramId?: string }) {
  const { t } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode);
  const manifest = useAppStore((s) => s.manifest);
  const loaded = useAppStore((s) => s.loadedTableCount);
  const failed = useAppStore((s) => s.failedTableCount);
  const ready = useAppStore((s) => s.ready);
  const total = useAppStore((s) => totalTableCount(s));

  const lastDiagramId = useAppStore((s) => s.lastDiagramId);
  const workspace = useCurrentWorkspace();
  const firstDiagram = manifest?.diagrams?.[0]?.id;
  // ER図 の遷移先: 現在ページ → 最後に閲覧したページ（今も存在する場合）→ 先頭ページ。
  // どれも無くても #/erd はページ作成の導線を出すので行き止まりにならない
  const validLast =
    lastDiagramId !== null && (manifest?.diagrams ?? []).some((d) => d.id === lastDiagramId)
      ? lastDiagramId
      : undefined;
  const target = currentDiagramId ?? validLast ?? firstDiagram;
  const erdHref = target !== undefined ? hrefs.erd(target) : hrefs.erdHome();
  const progress = total > 0 ? (loaded + failed) / total : 1;
  // タイトルは現在のワークスペース名（workspaces.js。未取得なら既定名）
  const titleText = workspace?.name ?? t("app.title");

  // 現在の画面のナビを濃色でハイライトする（モック）
  const route = useRoute();
  const kind = route.kind;
  const onErd = kind === "erd" || kind === "erdHome" || kind === "erdEdit";
  const onTables =
    kind === "tables" || kind === "table" || kind === "tableEdit" || kind === "tableDoc";
  const onColumns = kind === "columns" || kind === "columnsEdit";

  /*
   * 編集中は**ほかの画面へのナビを非活性にする**。編集ルートを離れると編集セッションが
   * 終わる（App がルートに追従する）ため、ナビを踏むと気づかないうちに編集が終了してしまう。
   * 現在の画面のナビだけは残すが、編集ルートを指させて「押しても何も起きない」ようにする。
   * 静的モードのテーブル/カラム編集ルートは App が閲覧へ逃がすので、ここでは編集扱いしない。
   */
  const erdEditing = kind === "erdEdit";
  const tableEditing = kind === "tableEdit" && serverMode === true;
  const columnsEditing = kind === "columnsEdit" && serverMode === true;
  const editingRoute = erdEditing || tableEditing || columnsEditing;
  const navHref = {
    erd: route.kind === "erdEdit" ? hrefs.erdEdit(route.diagramId) : erdHref,
    tables:
      route.kind === "tableEdit" && tableEditing ? hrefs.tableEdit(route.tableId) : hrefs.tables(),
    columns: columnsEditing ? hrefs.columnsEdit() : hrefs.columns(),
  };

  return (
    <header className={styles.appHeader}>
      {ready && progress < 1 && (
        <div
          className={styles.progressBar}
          role="progressbar"
          title={t("loading.tables", { loaded: loaded + failed, total })}
        >
          <div className={styles.progressBarFill} style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {/* 左端はアプリの顔（アイコン）＋ タイトル = 現在のワークスペース名。
          タイトルの文字そのものがワークスペース切替プルダウンのボタンになっている */}
      <div className={styles.appBrand}>
        <AppIconButton />
        <WorkspaceMenu title={titleText} className={styles.appTitle} />
      </div>
      <nav className={styles.appNav}>
        <NavLink href={navHref.erd} active={onErd} disabled={editingRoute && !erdEditing}>
          {t("nav.erd")}
        </NavLink>
        <NavLink href={navHref.tables} active={onTables} disabled={editingRoute && !tableEditing}>
          {t("nav.tables")}
        </NavLink>
        <NavLink
          href={navHref.columns}
          active={onColumns}
          disabled={editingRoute && !columnsEditing}
        >
          {t("nav.columns")}
        </NavLink>
        {serverMode === true && (
          <NavLink href={hrefs.introspect()} active={kind === "introspect"} disabled={editingRoute}>
            {t("nav.introspect")}
          </NavLink>
        )}
      </nav>
      <div className={styles.appHeaderRight}>
        {/* 常設のもの（画面に紐づかない操作）だけを置く。画面ごとの編集操作は右下（EditControls） */}
        <ToolsMenu />
        <InfoMenu />
        <SettingsMenu />
      </div>
    </header>
  );
}

/**
 * 共通ヘッダのナビ1件。非活性のときは <a> ではなく <span> にする
 * （href を消しただけの <a> はキーボード・中クリックで辿れてしまうため）。
 */
function NavLink({
  href,
  active,
  disabled,
  children,
}: {
  href: string;
  active: boolean;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const className = cx(styles.appNavLink, active && styles.active, disabled && styles.disabled);
  if (disabled) {
    return (
      <span className={className} aria-disabled="true" data-disabled="true" title={t("session.navLocked")}>
        {children}
      </span>
    );
  }
  return (
    <Link className={className} href={href}>
      {children}
    </Link>
  );
}

// ------------------------------------------------------------------ アプリアイコン（ヘッダ左端）

/**
 * ヘッダ左端のアプリアイコン。押すとアプリ情報（ロゴ・配布元）のダイアログを開く。
 * 右側のアイコン群（ツール・information・設定）とは役割が違うので、見た目も画像のまま置く。
 */
function AppIconButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={styles.appIconButton}
        data-testid="app-icon-button"
        title={t("about.title")}
        aria-label={t("about.title")}
        onClick={() => setOpen(true)}
      >
        {/* ロゴはボタンのラベル（aria-label）で読ませるので alt は空にする */}
        <img className={styles.appIcon} src={appIconUrl} alt="" />
      </button>
      {open && <AboutDialog onClose={() => setOpen(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ ツールメニュー（工具）

/**
 * ツール（データの持ち出し）。今は「全スキーマ情報を JSON で書き出す」1件だが、
 * 同種の一括操作が増える場所として独立したプルダウンにしている。
 *
 * 中身は手元に読み込み済みのデータから組み立てるため、**静的モードでも同じように使える**
 * （サーバー API を経由しない）。書き出しの中身の線引きは schemaExport.ts を参照。
 */
function ToolsMenu() {
  const { t } = useI18n();
  const addToast = useAppStore((s) => s.addToast);
  const serverMode = useAppStore((s) => s.serverMode) === true;
  const { open, setOpen, toggle, ref } = useDropdown();
  const [busy, setBusy] = useState(false);
  const [exportingViewer, setExportingViewer] = useState(false);

  const exportSchema = async (): Promise<void> => {
    setBusy(true);
    try {
      // 書き出しは全テーブルが対象。バックグラウンドロードの進み具合に依存させない
      await loadAllTables();
      const s = useAppStore.getState();
      const { data, missing } = buildSchemaExport({
        manifest: s.manifest,
        index: s.index,
        dictionary: s.dictionary,
        tables: s.tables,
      });
      downloadText(
        schemaExportFileName(s.workspaceId),
        serializeSchemaExport(data),
        "application/json",
      );
      setOpen(false);
      addToast(t("tools.exportSchemaDone", { n: data.tables.length }));
      // 読めなかったテーブルは黙って落とさない（件数だけ出す。原因はテーブル画面側で分かる）
      if (missing.length > 0) {
        addToast(t("tools.exportSchemaPartial", { n: missing.length }), "error");
      }
    } catch {
      addToast(t("tools.exportSchemaFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.menuAnchor} ref={ref}>
      <button
        type="button"
        className={cx(styles.iconButton, open && styles.active)}
        data-testid="tools-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("tools.title")}
        onClick={toggle}
      >
        <ToolIcon />
      </button>
      {open && (
        <div className={styles.toolsDropdown} role="menu" data-testid="tools-menu">
          <button
            type="button"
            role="menuitem"
            className={styles.toolItem}
            data-testid="export-schema-json"
            disabled={busy}
            onClick={() => void exportSchema()}
          >
            <span className={styles.toolItemLabel}>
              {busy ? t("tools.exportSchemaBusy") : t("tools.exportSchema")}
            </span>
            <span className={styles.toolItemHint}>{t("tools.exportSchemaHint")}</span>
          </button>
          {/* 閲覧用 ZIP はサーバーが組み立てる（index.html 自身を含むため静的モードでは作れない） */}
          <button
            type="button"
            role="menuitem"
            className={styles.toolItem}
            data-testid="export-viewer-zip"
            disabled={!serverMode}
            onClick={() => {
              setExportingViewer(true);
              setOpen(false);
            }}
          >
            <span className={styles.toolItemLabel}>{t("tools.exportViewer")}</span>
            <span className={styles.toolItemHint}>
              {serverMode ? t("tools.exportViewerHint") : t("tools.exportViewerStatic")}
            </span>
          </button>
        </div>
      )}
      {exportingViewer && <ViewerExportDialog onClose={() => setExportingViewer(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ 設定メニュー（歯車）

function SettingsMenu() {
  const { t, lang, setLang } = useI18n();
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const setNameDisplay = useAppStore((s) => s.setNameDisplay);
  const serverMode = useAppStore((s) => s.serverMode) === true;
  const workspace = useCurrentWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const [idDraft, setIdDraft] = useState(workspace?.id ?? "");
  const [nameDraft, setNameDraft] = useState(workspace?.name ?? "");
  const [savingName, setSavingName] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const { open, setOpen, toggle, ref } = useDropdown();

  // メニューを開いた時点の保存済みの値で下書きを同期する
  useEffect(() => {
    if (open) {
      setIdDraft(workspace?.id ?? "");
      setNameDraft(workspace?.name ?? "");
    }
  }, [open, workspace?.id, workspace?.name]);

  /**
   * ワークスペースの ID・表示名を変更する。
   * ID を変えるとフォルダ名（`workspace-<id>`）も変わるため、URL を張り替えてリロードする。
   */
  const saveWorkspace = async (): Promise<void> => {
    if (workspace === null) return;
    const id = idDraft.trim();
    const name = nameDraft.trim();
    if (!isValidWorkspaceId(id)) {
      addToast(t("workspace.idInvalid"), "error");
      return;
    }
    if (name === "") {
      addToast(t("workspace.nameRequired"), "error");
      return;
    }
    setSavingName(true);
    try {
      const res = await apiPatch(`/__erd/workspaces/${encodeURIComponent(workspace.id)}`, {
        id,
        name,
      });
      if (res.status === 200) {
        // ID が変わっていれば URL ごと差し替わる（変わっていなければ名前の反映だけ）
        location.hash = hrefs.workspace(id);
        location.reload();
        return;
      }
      const body = JSON.parse(res.body) as { code?: string };
      addToast(
        body.code === "DUPLICATE_ID"
          ? t("workspace.duplicate", { id })
          : `${t("save.failed")} (HTTP ${res.status})`,
        "error",
      );
    } catch {
      addToast(t("save.failed"), "error");
    } finally {
      setSavingName(false);
    }
  };

  // データリセット: このワークスペースのスキーマ情報だけを削除し、
  // 通常のロード経路をやり直す（同じワークスペースのブートストラップ画面へ着地する）
  const doReset = async (): Promise<void> => {
    setConfirmReset(false);
    setOpen(false);
    try {
      const res = await apiPost(wpath("/reset"), {});
      if (res.status === 200) {
        // 完了通知はリロード後に出す（この直後に画面を読み込み直すため）
        queueToastAfterReload(t("reset.done"));
        location.reload();
      } else {
        addToast(`${t("reset.failed")} (HTTP ${res.status})`, "error");
      }
    } catch {
      addToast(t("reset.failed"), "error");
    }
  };

  const workspaceChanged =
    workspace !== null &&
    (idDraft.trim() !== workspace.id || nameDraft.trim() !== workspace.name);

  return (
    <div className={styles.menuAnchor} ref={ref}>
      <button
        type="button"
        className={cx(styles.iconButton, open && styles.active)}
        data-testid="settings-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("settings.title")}
        onClick={toggle}
      >
        <GearIcon />
      </button>
      {open && (
        <div className={styles.settingsDropdown} role="menu" data-testid="settings-menu">
          <label className={styles.settingsRow}>
            <span className={styles.settingsLabel}>{t("nameDisplay.label")}</span>
            <select
              className={styles.headerSelect}
              data-testid="header-select"
              value={nameDisplay}
              onChange={(e) => setNameDisplay(e.target.value as NameDisplay)}
            >
              <option value="both">{t("nameDisplay.both")}</option>
              <option value="logical">{t("nameDisplay.logical")}</option>
              <option value="physical">{t("nameDisplay.physical")}</option>
            </select>
          </label>
          <label className={styles.settingsRow}>
            <span className={styles.settingsLabel}>{t("lang.label")}</span>
            <select
              className={styles.headerSelect}
              data-testid="header-select"
              value={lang}
              onChange={(e) => setLang(e.target.value as Lang)}
            >
              <option value="ja">日本語</option>
              <option value="en">English</option>
            </select>
          </label>

          {/* ワークスペース（ID・表示名。サーバーモードのみ変更可能） */}
          <div className={styles.settingsBlock}>
            <span className={styles.settingsLabel}>{t("workspace.rename")}</span>
            {serverMode && workspace !== null ? (
              <>
                <input
                  type="text"
                  className={styles.settingsInput}
                  data-testid="workspace-id-input"
                  aria-label={t("workspace.id")}
                  value={idDraft}
                  onChange={(e) => setIdDraft(e.target.value)}
                />
                <div className={styles.settingsInputRow}>
                  <input
                    type="text"
                    className={styles.settingsInput}
                    data-testid="workspace-name-input"
                    aria-label={t("workspace.name")}
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                  />
                  <Button
                    variant="primary"
                    data-testid="workspace-save"
                    disabled={!workspaceChanged || savingName}
                    onClick={() => void saveWorkspace()}
                  >
                    {savingName ? t("save.saving") : t("save.button")}
                  </Button>
                </div>
                {idDraft.trim() !== workspace.id && (
                  <span className="muted">{t("workspace.renameIdWarn")}</span>
                )}
              </>
            ) : (
              <span className="muted">{workspace?.name ?? ""}</span>
            )}
          </div>

          {/* AI 連携（MCP。Q-01）。接続口はこのサーバー自身なのでサーバーモード専用 */}
          {serverMode && (
            <div className={styles.settingsBlock}>
              <span className={styles.settingsLabel}>{t("settings.mcp")}</span>
              <Button
                className={styles.blockButton}
                data-testid="mcp-settings"
                onClick={() => {
                  setMcpOpen(true);
                  setOpen(false);
                }}
              >
                {t("settings.mcpAction")}
              </Button>
            </div>
          )}

          {/* データリセット（このワークスペースのスキーマ情報だけを消す）とワークスペース削除。
              破壊力が違うため別々の操作として並べる（§11） */}
          {serverMode && (
            <div className={styles.settingsBlock}>
              <span className={styles.settingsLabel}>{t("settings.dataReset")}</span>
              <Button
                variant="danger"
                className={styles.blockButton}
                data-testid="data-reset"
                onClick={() => setConfirmReset(true)}
              >
                {t("settings.dataResetAction")}
              </Button>
            </div>
          )}
          {serverMode && workspace !== null && (
            <div className={styles.settingsBlock}>
              <span className={styles.settingsLabel}>{t("workspace.delete")}</span>
              <Button
                variant="danger"
                className={styles.blockButton}
                data-testid="workspace-delete"
                onClick={() => setConfirmDelete(true)}
              >
                {t("workspace.deleteAction")}
              </Button>
            </div>
          )}
        </div>
      )}

      {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}

      {confirmDelete && workspace !== null && (
        <WorkspaceDeleteDialog workspace={workspace} onClose={() => setConfirmDelete(false)} />
      )}

      {confirmReset && (
        <Dialog title={t("reset.title")} onClose={() => setConfirmReset(false)}>
          <p>{t("reset.body")}</p>
          <div className="dialog-actions">
            <Button
              variant="danger"
              data-testid="data-reset-confirm"
              onClick={() => void doReset()}
            >
              {t("reset.confirm")}
            </Button>
            <Button onClick={() => setConfirmReset(false)}>{t("layout.cancel")}</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ information（ⓘ）

/**
 * information（A-02）。読むだけの情報を集める場所で、操作は置かない（操作は設定＝歯車）。
 *
 * - リリースバージョン。サーバーモードでは index.html と erd-server.jar の**両方**を出す。
 *   この2つは配布 ZIP の中で別ファイルなので、片方だけ差し替えられて食い違うことがある。
 *   食い違いはそれ自体が不具合の原因になるため、検出したら注意文を出す
 * - 動作モード（静的 / サーバー）。以前はヘッダ常設のアイコンだったが、ここへ文字で移した
 * - データ形式（schemaVersion）。リリース版とは独立した軸で、不具合報告のときに効く
 */
/** 開発ビルドの版か（"dev" / "0.2.0-dev"）。リリースビルドだけが確定版になる */
function isDevVersion(v: string): boolean {
  return v.endsWith("dev");
}

function InfoMenu() {
  const { t } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode);
  const serverVersion = useAppStore((s) => s.serverVersion);
  const schemaVersion = useAppStore((s) => s.manifest?.schemaVersion ?? null);
  const { open, toggle, ref } = useDropdown();

  const server = serverMode === true;
  // 判定中（null）を静的と言い切らない。モード判定は非同期（A-01）
  const mode = serverMode === null ? "unknown" : server ? "server" : "static";
  // 突き合わせるのは**リリース版どうし**のときだけ。開発ビルドは片側が "dev" / "x.y.z-dev" に
  // なり、必ず食い違って見えるため（古いサーバーは appVersion 自体を返さない）
  const releases = serverVersion !== null && !isDevVersion(APP_VERSION) && !isDevVersion(serverVersion);
  const mismatch = server && releases && serverVersion !== APP_VERSION;

  return (
    <div className={styles.menuAnchor} ref={ref}>
      <button
        type="button"
        className={cx(styles.iconButton, open && styles.active)}
        data-testid="info-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("info.title")}
        onClick={toggle}
      >
        <InfoIcon />
      </button>
      {open && (
        <div className={styles.infoDropdown} role="menu" data-testid="info-menu">
          <div className={styles.infoBlock}>
            <span className={styles.settingsLabel}>{t("info.version")}</span>
            {server ? (
              <>
                <div className={styles.infoRow}>
                  <span className="muted">{t("info.viewerVersion")}</span>
                  <span className={styles.infoValue} data-testid="viewer-version">
                    {APP_VERSION}
                  </span>
                </div>
                <div className={styles.infoRow}>
                  <span className="muted">{t("info.serverVersion")}</span>
                  <span className={styles.infoValue} data-testid="server-version">
                    {serverVersion ?? "—"}
                  </span>
                </div>
              </>
            ) : (
              <span className={styles.infoValue} data-testid="viewer-version">
                {APP_VERSION}
              </span>
            )}
            {mismatch && <span className={styles.infoWarn}>{t("info.versionMismatch")}</span>}
          </div>

          <div className={styles.infoBlock}>
            <span className={styles.settingsLabel}>{t("mode.label")}</span>
            <span className={styles.infoValue} data-testid="info-mode" data-mode={mode}>
              {mode === "unknown" ? "…" : server ? t("mode.server") : t("mode.static")}
            </span>
            {mode !== "unknown" && (
              <span className="muted">{server ? t("mode.serverDesc") : t("mode.staticDesc")}</span>
            )}
          </div>

          {schemaVersion !== null && (
            <div className={styles.infoBlock}>
              <span className={styles.settingsLabel}>{t("info.schemaVersion")}</span>
              <span className={styles.infoValue} data-testid="info-schema-version">
                v{schemaVersion}
              </span>
            </div>
          )}

          {/* 著作権表示は LICENSE と文字列を一致させる（年も固定。ビルド年を自動で入れない）。
              Powered by は謝辞で、ライセンス表示の代わりにはならない。義務を満たすのは
              配布 ZIP 同梱の THIRD-PARTY-NOTICES.txt のほう（そちらへ誘導する）。
              固有名詞だけの2行は翻訳しない */}
          <div className={styles.infoFooter}>
            <span data-testid="info-copyright">© 2026 artistrytech · MIT License</span>
            <span>Powered by React · React Flow · Javalin · ELK</span>
            <span className={styles.infoNotices}>{t("info.notices")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- アイコン（インライン SVG）

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * ツール（スパナ＋ドライバー）。データの持ち出しなど、画面に紐づかない一括操作の入口。
 * 塗りのアイコンだが、ホバー・選択でヘッダの他のアイコンと同じように色が変わるよう
 * 元データの固定色（#4B4B4B）は currentColor に置き換えている。
 */
function ToolIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">
      <path d="M360.102,240.012l10.156-10.266c0,0,15.609-13.406,33.406-7.328c30.984,10.578,66.781-0.875,91.609-25.734c7.063-7.063,15.641-21.234,15.641-21.234c0.984-1.344,1.328-3.047,0.922-4.672l-1.922-7.906c-0.359-1.484-1.313-2.75-2.625-3.531c-1.313-0.766-2.891-0.969-4.344-0.547l-60.984,16.969c-2.266,0.625-4.688-0.219-6.063-2.109l-28.015-38.594c-0.859-1.172-1.219-2.641-1.016-4.063l5.641-41c0.297-2.234,1.891-4.047,4.063-4.656l64.406-17.922c2.906-0.813,4.672-3.813,3.953-6.766l-2.547-10.359c-0.344-1.469-1.281-2.719-2.563-3.5c0,0-5.047-3.344-8.719-5.234c-36.578-18.891-82.64-13.031-113.312,17.656c-22.656,22.656-31.531,53.688-27.375,83.156c3.203,22.656,1.703,34.703-8.078,45.047c-0.891,0.922-3.703,3.734-8.047,8L360.102,240.012z" />
      <path d="M211.383,295.418C143.024,361.652,68.461,433.715,68.461,433.715c-2.547,2.438-4,5.797-4.047,9.313c-0.047,3.5,1.344,6.891,3.813,9.375l31.938,31.938c2.5,2.484,5.875,3.859,9.391,3.813c3.516-0.031,6.859-1.5,9.281-4.031l139.328-140.953L211.383,295.418z" />
      <path d="M501.43,451.371c2.484-2.484,3.859-5.859,3.813-9.375c-0.031-3.516-1.5-6.859-4.031-9.297L227.415,166.246l-43.953,43.969L450.805,483.09c2.438,2.547,5.781,4,9.297,4.047s6.891-1.344,9.391-3.828L501.43,451.371z" />
      <path d="M254.196,32.621c-32.969-12.859-86.281-14.719-117.156,16.141c-24.313,24.313-59.875,59.891-59.875,59.891c-12.672,12.656-0.906,25.219-10.266,34.563c-9.359,9.359-24.313,0-32.734,8.422L3.29,182.527c-4.391,4.375-4.391,11.5,0,15.891l43.016,43.016c4.391,4.391,11.516,4.391,15.906,0l30.875-30.875c8.438-8.422-0.938-23.375,8.438-32.719c12.609-12.625,26.375-10.484,34.328-2.547l15.891,15.891l17.219,4.531l43.953-43.953l-5.063-16.688c-14.016-14.031-16.016-30.266-7.234-39.047c13.594-13.594,36.047-33.234,57.078-41.656C271.102,49.012,267.055,35.668,254.196,32.621z M194.571,103.48c-0.063,0.047,5.859-7.281,5.969-7.375L194.571,103.48z" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <line x1="12" y1="7.5" x2="12.01" y2="7.5" />
    </svg>
  );
}
