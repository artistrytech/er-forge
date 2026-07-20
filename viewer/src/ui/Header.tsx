/**
 * ヘッダ（A-02 / A-03 / L-04 / P-05）。
 * 動作モードと編集セッションを別々に常時表示する。Phase1 は常に「閲覧中」。
 * データ読み込み進捗は上部の細いプログレスバーで示す（初回描画をブロックしない）。
 */
import { useI18n } from "../i18n/useI18n";
import { useEditStore } from "../model/editStore";
import type { NameDisplay } from "../model/logicalName";
import { totalTableCount, useAppStore } from "../model/store";
import type { Lang } from "../i18n/messages";
import { Link } from "./Link";
import { hrefs } from "./router";

export function Header({
  currentDiagramId,
  onErdRoute,
}: {
  currentDiagramId?: string;
  onErdRoute?: boolean;
}) {
  const { t, lang, setLang } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const setNameDisplay = useAppStore((s) => s.setNameDisplay);
  const manifest = useAppStore((s) => s.manifest);
  const loaded = useAppStore((s) => s.loadedTableCount);
  const failed = useAppStore((s) => s.failedTableCount);
  const ready = useAppStore((s) => s.ready);
  const total = useAppStore((s) => totalTableCount(s));

  const firstDiagram = manifest?.diagrams?.[0]?.id;
  // ページが1枚も無くても ER図 へは行ける（#/erd がページ作成の導線を出す）
  const target = currentDiagramId ?? firstDiagram;
  const erdHref = target !== undefined ? hrefs.erd(target) : hrefs.erdHome();
  const progress = total > 0 ? (loaded + failed) / total : 1;

  return (
    <header className="app-header">
      {ready && progress < 1 && (
        <div
          className="progress-bar"
          role="progressbar"
          title={t("loading.tables", { loaded: loaded + failed, total })}
        >
          <div className="progress-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <div className="app-title">{t("app.title")}</div>
      <nav className="app-nav">
        <Link className="app-nav-link" href={erdHref}>
          {t("nav.erd")}
        </Link>
        <Link className="app-nav-link" href={hrefs.tables()}>
          {t("nav.tables")}
        </Link>
        <Link className="app-nav-link" href={hrefs.columns()}>
          {t("nav.columns")}
        </Link>
        {serverMode === true && (
          <Link className="app-nav-link" href={hrefs.introspect()}>
            {t("nav.introspect")}
          </Link>
        )}
      </nav>
      <div className="app-header-right">
        <select
          className="header-select"
          value={nameDisplay}
          onChange={(e) => setNameDisplay(e.target.value as NameDisplay)}
          title={t("nameDisplay.both")}
        >
          <option value="both">{t("nameDisplay.both")}</option>
          <option value="logical">{t("nameDisplay.logical")}</option>
          <option value="physical">{t("nameDisplay.physical")}</option>
        </select>
        <select
          className="header-select"
          value={lang}
          onChange={(e) => setLang(e.target.value as Lang)}
          title={t("lang.label")}
        >
          <option value="ja">日本語</option>
          <option value="en">English</option>
        </select>
        <span className={"mode-badge " + (serverMode === true ? "mode-server" : "mode-static")}>
          {t("mode.label")}: {serverMode === true ? t("mode.server") : t("mode.static")}
        </span>
        <SessionControls
          onErdPage={onErdRoute === true || currentDiagramId !== undefined}
          diagramId={currentDiagramId}
        />
      </div>
    </header>
  );
}

/**
 * 編集セッションの表示と切替（A-02 / H-10）+ 保存状態（H-04）。
 * 閲覧ルート ⇄ 編集ルートを URL で分ける（§4.4）。編集は [編集開始] リンクで
 * 編集ルートへ遷移して初めて始まり、[編集終了] で閲覧ルートへ戻る（未保存があれば
 * ErdPage の離脱ガードが確認する）。自動保存は無く、保存はすべて明示（H-03）。
 * ER図ページ以外ではここに何も出さない（テーブル編集・カラム論理名は各画面が
 * 独自の編集 UI を持つ）。
 */
function SessionControls({ onErdPage, diagramId }: { onErdPage: boolean; diagramId?: string }) {
  const { t } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode);
  const session = useEditStore((s) => s.session);
  const status = useEditStore((s) => s.status);
  const failMessage = useEditStore((s) => s.failMessage);
  const pendingCount = useEditStore((s) => s.pendingCount);
  const save = useEditStore((s) => s.save);
  const retry = useEditStore((s) => s.retry);
  const openExport = useEditStore((s) => s.openExport);

  if (!onErdPage || diagramId === undefined) return null;
  const editing = session === "editing";

  return (
    <>
      <span className={"session-badge" + (editing ? " session-editing" : "")}>
        {editing ? `● ${t("session.editing")}` : t("session.viewing")}
      </span>
      {editing && serverMode === false && (
        <span className="save-warn" title={t("edit.staticWarn.body")}>
          {t("session.notSaved")}
        </span>
      )}
      {editing && serverMode === true && (
        <SaveStatus
          status={status}
          failMessage={failMessage}
          pendingCount={pendingCount}
          onSave={save}
          onRetry={retry}
        />
      )}
      {editing && (
        <button type="button" className="header-button" onClick={() => openExport(diagramId)}>
          {t("edit.exportButton")}
        </button>
      )}
      {editing ? (
        <Link
          className="header-button"
          data-testid="session-toggle"
          href={hrefs.erd(diagramId)}
        >
          {t("session.endEdit")}
        </Link>
      ) : (
        <Link
          className="header-button header-button-primary"
          data-testid="session-toggle"
          href={hrefs.erdEdit(diagramId)}
        >
          {t("session.startEdit")}
        </Link>
      )}
    </>
  );
}

function SaveStatus({
  status,
  failMessage,
  pendingCount,
  onSave,
  onRetry,
}: {
  status: "saved" | "dirty" | "saving" | "failed";
  failMessage: string | null;
  pendingCount: number;
  onSave: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  if (status === "failed") {
    return (
      <span className="save-status save-failed" data-testid="save-status">
        {t("save.failed")}
        {failMessage !== null && ` (${failMessage})`}
        <button type="button" onClick={onRetry}>
          {t("save.retry")}
        </button>
      </span>
    );
  }
  if (status === "saving") {
    return (
      <span className="save-status" data-testid="save-status">
        {t("save.saving")}
      </span>
    );
  }
  if (status === "dirty") {
    return (
      <span className="save-status save-dirty" data-testid="save-status">
        {t("save.unsaved", { n: pendingCount })}
        <button type="button" data-testid="save-button" onClick={onSave}>
          {t("save.button")}
        </button>
      </span>
    );
  }
  return (
    <span className="save-status save-saved" data-testid="save-status">
      {t("save.saved")}
    </span>
  );
}
