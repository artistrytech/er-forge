/**
 * ヘッダ（A-02 / A-03 / L-04 / P-05）。
 * 右側は「information（ⓘ）」「設定（歯車）」と、画面に応じた編集操作（保存・編集開始/終了）で構成する。
 * 動作モードは information の中に文字で置く（常時表示のアイコンは廃止した）。
 * 代わりに、静的モードで編集を始めたときだけ「保存されません」をヘッダに出す（A-02）。
 * 編集操作は ER図（editStore）・テーブル編集 / カラム辞書の編集（pageEditStore のコントローラ）を
 * ひとつのヘッダ UI に集約する。個別画面はフォームだけを持ち、保存・終了はここから行う。
 */
import { useEffect, useState } from "react";
import appIconUrl from "../assets/app-icon.png";
import { useI18n } from "../i18n/useI18n";
import { apiPatch, apiPost, wpath } from "../model/api";
import { useEditStore } from "../model/editStore";
import { loadAllTables } from "../model/loader";
import { usePageEditStore, type PageEditController } from "../model/pageEditStore";
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
import { ViewerExportDialog } from "./ViewerExportDialog";
import { Link } from "./Link";
import { hrefs, useRoute, type Route } from "./router";
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
  const onTables = kind === "tables" || kind === "table" || kind === "tableEdit";
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
        {/* 画面によって出入りする編集操作を右端に置き、常設のツール・information・設定はその左に固定する
            （編集操作の有無でアイコンの位置がずれないようにするため） */}
        <ToolsMenu />
        <InfoMenu />
        <SettingsMenu />
        <EditControls route={route} />
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

// ------------------------------------------------------------------ 編集操作（保存・開始・終了）

/**
 * 画面に応じた編集操作を1か所に集約する。
 * - ER図（editStore）: 閲覧なら [編集開始]、編集中なら [保存]（サーバー）/[エクスポート]（静的）＋[編集終了]
 * - テーブル編集 / カラム辞書の編集（pageEditStore コントローラ）: [保存]＋[編集終了]、閲覧なら [編集開始]
 * 未保存があるまま [編集終了] を押したときだけ確認ダイアログを出す（他の遷移・リロードは対象外）。
 */
function EditControls({ route }: { route: Route }) {
  const { t } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode);
  const session = useEditStore((s) => s.session);
  const status = useEditStore((s) => s.status);
  const failMessage = useEditStore((s) => s.failMessage);
  const pendingCount = useEditStore((s) => s.pendingCount);
  // 正味の変更があるか（移動→Undo で相殺されたら false。Undo スタックが尽きた状態）
  const netDirty = useEditStore((s) => s.netDirty);
  const save = useEditStore((s) => s.save);
  const retry = useEditStore((s) => s.retry);
  const openExport = useEditStore((s) => s.openExport);
  const controller = usePageEditStore((s) => s.controller);
  // ページ情報（追加・改名・並び替え・削除）の編集中は、ER図・テーブルの編集を始めさせない。
  // どちらも「編集中」の見た目になり、何を編集しているのかが読めなくなるため（相互排他）
  const pageInfoEditing = useAppStore((s) => s.pageInfoEditing);
  // 未保存があるまま終了を押したときに開く確認（保持している関数を実行すると終了する）
  const [pendingEnd, setPendingEnd] = useState<{ run: () => void } | null>(null);

  const requestEnd = (dirty: boolean, end: () => void): void => {
    if (dirty) setPendingEnd({ run: end });
    else end();
  };

  let body: React.ReactNode = null;

  if (route.kind === "erd" || route.kind === "erdEdit") {
    // ER図
    const erdId = route.diagramId;
    if (erdId !== undefined) {
      const editing = session === "editing";
      if (!editing) {
        body = <StartEditButton href={hrefs.erdEdit(erdId)} locked={pageInfoEditing} />;
      } else {
        const dirty = netDirty;
        body = (
          <>
            {serverMode === true && (
              <SaveButton
                status={status}
                title={saveTitle(t, status, failMessage, pendingCount)}
                disabled={status === "saved" || status === "saving"}
                onClick={() => (status === "failed" ? retry() : save())}
              />
            )}
            {/* 静的モードは保存先が無い。動作モードの常設表示を information に畳んだため、
                「保存されない」ことだけは編集中のヘッダに出し続ける（A-02） */}
            {serverMode === false && (
              <>
                <span className={styles.staticWarning} data-testid="static-warning">
                  {t("session.notSaved")}
                </span>
                <button
                  type="button"
                  className={styles.iconButton}
                  data-testid="export-button"
                  title={t("edit.exportButton")}
                  onClick={() => openExport(erdId)}
                >
                  <ExportIcon />
                </button>
              </>
            )}
            <EndEditButton onClick={() => requestEnd(dirty, () => (location.hash = hrefs.erd(erdId)))} />
          </>
        );
      }
    }
  } else if (route.kind === "table" || route.kind === "tableEdit") {
    const tableId = route.tableId;
    if (route.kind === "tableEdit") {
      // 編集ルート。サーバーモードのみ（静的モードは App が詳細へリダイレクト）
      if (serverMode === true && controller) {
        body = <PageEditButtons controller={controller} onEnd={requestEnd} />;
      }
    } else if (serverMode === true) {
      // ビュー等も同じ導線で編集する。編集できるのは meta のみ（TableEdit）なので、
      // 種別で入口を分ける必要がない（K-16 詳細設計 §7）
      body = <StartEditButton href={hrefs.tableEdit(tableId)} locked={pageInfoEditing} />;
    }
  } else if (route.kind === "columns" || route.kind === "columnsEdit") {
    if (route.kind === "columnsEdit") {
      if (serverMode === true && controller) {
        body = <PageEditButtons controller={controller} onEnd={requestEnd} />;
      }
    } else if (serverMode === true) {
      body = <StartEditButton href={hrefs.columnsEdit()} />;
    }
  }

  return (
    <>
      {body}
      {pendingEnd !== null && (
        <Dialog title={t("edit.stopConfirm.title")} onClose={() => setPendingEnd(null)}>
          <p>{t("session.endConfirmBody")}</p>
          <div className="dialog-actions">
            <Button
              variant="primary"
              data-testid="end-confirm-discard"
              onClick={() => {
                const run = pendingEnd.run;
                setPendingEnd(null);
                run();
              }}
            >
              {t("edit.stopConfirm.discard")}
            </Button>
            <Button onClick={() => setPendingEnd(null)}>{t("layout.cancel")}</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** テーブル編集 / カラム論理名編集の [保存]＋[編集終了]（pageEditStore コントローラ由来） */
function PageEditButtons({
  controller,
  onEnd,
}: {
  controller: PageEditController;
  onEnd: (dirty: boolean, end: () => void) => void;
}) {
  const { t } = useI18n();
  const { dirty, saving, canSave } = controller;
  const status: SaveStatusKind = saving ? "saving" : dirty ? "dirty" : "saved";
  return (
    <>
      <SaveButton
        status={status}
        title={saving ? t("save.saving") : t("save.button")}
        disabled={!dirty || saving || !canSave}
        onClick={controller.save}
      />
      <EndEditButton onClick={() => onEnd(dirty, controller.end)} />
    </>
  );
}

type SaveStatusKind = "saved" | "dirty" | "saving" | "failed";

function saveTitle(
  t: ReturnType<typeof useI18n>["t"],
  status: SaveStatusKind,
  failMessage: string | null,
  pendingCount: number,
): string {
  if (status === "failed") {
    return `${t("save.failed")}${failMessage !== null ? ` (${failMessage})` : ""} — ${t("save.retry")}`;
  }
  if (status === "saving") return t("save.saving");
  if (status === "dirty") return `${t("save.button")} (${t("save.unsaved", { n: pendingCount })})`;
  return t("save.saved");
}

function SaveButton({
  status,
  title,
  disabled,
  onClick,
}: {
  status: SaveStatusKind;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cx(styles.iconButton, status === "failed" && styles.iconDanger, status === "dirty" && styles.iconPrimary)}
      data-testid="save-button"
      data-status={status}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <SaveIcon />
    </button>
  );
}

/** locked = ページ情報の編集中（そちらを終えるまで、この画面の編集は始められない） */
function StartEditButton({ href, locked = false }: { href: string; locked?: boolean }) {
  const { t } = useI18n();
  if (locked) {
    return (
      <button
        type="button"
        className={styles.iconButton}
        data-testid="session-toggle"
        data-editing="false"
        disabled
        title={t("session.lockedByPageEdit")}
      >
        <PenIcon />
      </button>
    );
  }
  return (
    <Link
      className={cx(styles.iconButton, styles.iconPrimary)}
      data-testid="session-toggle"
      data-editing="false"
      href={href}
      title={t("session.startEdit")}
    >
      <PenIcon />
    </Link>
  );
}

function EndEditButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={styles.iconButton}
      data-testid="session-toggle"
      data-editing="true"
      title={t("session.endEdit")}
      onClick={onClick}
    >
      <CloseIcon />
    </button>
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

function SaveIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

/** ツール（レンチ）。データの持ち出しなど、画面に紐づかない一括操作の入口 */
function ToolIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M14.7 6.3a4 4 0 0 0 5 5l-9 9a2.5 2.5 0 0 1-3.5-3.5z" />
      <path d="M19.7 11.3 21 10a5.5 5.5 0 0 0-7-7l2.3 2.3-1.6 3.9-3.9 1.6L8.5 8.6" />
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
