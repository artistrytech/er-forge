/**
 * ヘッダ（A-02 / A-03 / L-04 / P-05）。
 * 右側は「設定（歯車）」「動作モード（アイコン）」と、画面に応じた編集操作（保存・編集開始/終了）で構成する。
 * 編集操作は ER図（editStore）・テーブル編集 / カラム論理名編集（pageEditStore のコントローラ）を
 * ひとつのヘッダ UI に集約する。個別画面はフォームだけを持ち、保存・終了はここから行う。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { apiPatch, apiPost, wpath } from "../model/api";
import { useEditStore } from "../model/editStore";
import { usePageEditStore, type PageEditController } from "../model/pageEditStore";
import type { NameDisplay } from "../model/logicalName";
import { queueToastAfterReload, totalTableCount, useAppStore } from "../model/store";
import { isValidWorkspaceId, type WorkspaceRef } from "../model/workspace";
import type { Lang } from "../i18n/messages";
import { cx } from "../lib/cx";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Link } from "./Link";
import { hrefs, useRoute, type Route } from "./router";
import { WorkspaceDeleteDialog, WorkspaceMenu } from "./Workspace";
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
      {/* タイトル = 現在のワークスペース名。名前そのものが切替プルダウンのボタン */}
      <WorkspaceMenu title={titleText} className={styles.appTitle} />
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
        {/* 右側アイコン群の一番左に設定（歯車）。表示名・言語の切替をここに集約する */}
        <SettingsMenu />
        <ModeIndicator serverMode={serverMode} />
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

// ------------------------------------------------------------------ 設定メニュー（歯車）

function SettingsMenu() {
  const { t, lang, setLang } = useI18n();
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const setNameDisplay = useAppStore((s) => s.setNameDisplay);
  const serverMode = useAppStore((s) => s.serverMode) === true;
  const workspace = useCurrentWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const [open, setOpen] = useState(false);
  const [idDraft, setIdDraft] = useState(workspace?.id ?? "");
  const [nameDraft, setNameDraft] = useState(workspace?.name ?? "");
  const [savingName, setSavingName] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // メニューを開いた時点の保存済みの値で下書きを同期する
  useEffect(() => {
    if (open) {
      setIdDraft(workspace?.id ?? "");
      setNameDraft(workspace?.name ?? "");
    }
  }, [open, workspace?.id, workspace?.name]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
    <div className={styles.settingsMenu} ref={ref}>
      <button
        type="button"
        className={cx(styles.iconButton, open && styles.active)}
        data-testid="settings-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("settings.title")}
        onClick={() => setOpen((o) => !o)}
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

// ------------------------------------------------------------------ 動作モード（アイコン）

function ModeIndicator({ serverMode }: { serverMode: boolean | null }) {
  const { t } = useI18n();
  const server = serverMode === true;
  return (
    <span
      className={cx(styles.modeIndicator, server ? styles.modeServer : styles.modeStatic)}
      data-testid="mode-badge"
      data-mode={server ? "server" : "static"}
      title={`${t("mode.label")}: ${server ? t("mode.server") : t("mode.static")}\n${
        server ? t("mode.serverDesc") : t("mode.staticDesc")
      }`}
    >
      {server ? <ServerIcon /> : <StaticIcon />}
    </span>
  );
}

// ------------------------------------------------------------------ 編集操作（保存・開始・終了）

/**
 * 画面に応じた編集操作を1か所に集約する。
 * - ER図（editStore）: 閲覧なら [編集開始]、編集中なら [保存]（サーバー）/[エクスポート]（静的）＋[編集終了]
 * - テーブル編集 / カラム論理名編集（pageEditStore コントローラ）: [保存]＋[編集終了]、閲覧なら [編集開始]
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
            {serverMode === false && (
              <button
                type="button"
                className={styles.iconButton}
                data-testid="export-button"
                title={t("edit.exportButton")}
                onClick={() => openExport(erdId)}
              >
                <ExportIcon />
              </button>
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

function ServerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <line x1="7" y1="7.5" x2="7.01" y2="7.5" />
      <line x1="7" y1="16.5" x2="7.01" y2="16.5" />
    </svg>
  );
}

function StaticIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
