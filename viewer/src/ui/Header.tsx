/**
 * ヘッダ（A-02 / A-03 / L-04 / P-05）。
 * 動作モードと編集セッションを別々に常時表示する。Phase1 は常に「閲覧中」。
 * データ読み込み進捗は上部の細いプログレスバーで示す（初回描画をブロックしない）。
 */
import { useI18n } from "../i18n/useI18n";
import type { NameDisplay } from "../model/logicalName";
import { totalTableCount, useAppStore } from "../model/store";
import type { Lang } from "../i18n/messages";
import { Link } from "./Link";
import { hrefs } from "./router";

export function Header({ currentDiagramId }: { currentDiagramId?: string }) {
  const { t, lang, setLang } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const setNameDisplay = useAppStore((s) => s.setNameDisplay);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const manifest = useAppStore((s) => s.manifest);
  const loaded = useAppStore((s) => s.loadedTableCount);
  const failed = useAppStore((s) => s.failedTableCount);
  const ready = useAppStore((s) => s.ready);
  const total = useAppStore((s) => totalTableCount(s));

  const firstDiagram = manifest?.diagrams?.[0]?.id;
  const erdHref = hrefs.erd(currentDiagramId ?? firstDiagram ?? "");
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
        {firstDiagram !== undefined && (
          <Link className="app-nav-link" href={erdHref}>
            {t("nav.erd")}
          </Link>
        )}
        <Link className="app-nav-link" href={hrefs.tables()}>
          {t("nav.tables")}
        </Link>
        <button type="button" className="app-nav-button" onClick={() => setSearchOpen(true)}>
          🔍 {t("nav.search")} <kbd>{t("nav.searchHint")}</kbd>
        </button>
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
        <span className="session-badge">{t("session.viewing")}</span>
      </div>
    </header>
  );
}
