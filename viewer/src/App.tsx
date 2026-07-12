/**
 * ルート切替と全体レイアウト。
 * バージョン不整合・データ欠損時は描画せずバナーのみ表示する（A-04 / §3.6）。
 */
import { useEffect } from "react";
import { TableDetail } from "./catalog/TableDetail";
import { TableList } from "./catalog/TableList";
import { ErdPage } from "./canvas/ErdPage";
import { useI18n } from "./i18n/useI18n";
import { totalTableCount, useAppStore, type Fatal } from "./model/store";
import { BootstrapScreen } from "./ui/BootstrapScreen";
import { Header } from "./ui/Header";
import { Link } from "./ui/Link";
import { NotFound } from "./ui/NotFound";
import { RelationDialog } from "./ui/RelationDialog";
import { SearchDialog } from "./ui/SearchDialog";
import { Sidebar } from "./ui/Sidebar";
import { TableDetailDialog } from "./ui/TableDetailDialog";
import { hrefs, replaceRoute, useRoute } from "./ui/router";

export function App() {
  const { t } = useI18n();
  const route = useRoute();
  const fatal = useAppStore((s) => s.fatal);
  const ready = useAppStore((s) => s.ready);
  const manifest = useAppStore((s) => s.manifest);
  const dialog = useAppStore((s) => s.dialog);
  const searchOpen = useAppStore((s) => s.searchOpen);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const tableErrors = useAppStore((s) => s.tableErrors);
  const loaded = useAppStore((s) => s.loadedTableCount);
  const failed = useAppStore((s) => s.failedTableCount);
  const total = useAppStore((s) => totalTableCount(s));

  // N-01: Cmd/Ctrl + K で検索を開く
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSearchOpen]);

  if (fatal !== null) {
    return <FatalBanner fatal={fatal} />;
  }
  if (!ready) {
    return <div className="boot-loading">{t("canvas.loading")}</div>;
  }

  const firstDiagram = manifest?.diagrams?.[0]?.id;
  const currentDiagramId = route.kind === "erd" ? route.diagramId : undefined;
  const failedIds = Object.keys(tableErrors);

  let content: React.ReactNode;
  switch (route.kind) {
    case "home":
      // 既定画面へリダイレクト: ページがあれば最初の ER図、なければテーブル一覧
      replaceRoute(firstDiagram !== undefined ? hrefs.erd(firstDiagram) : hrefs.tables());
      content = null;
      break;
    case "erd":
      content = (
        <div className="erd-layout">
          <Sidebar currentDiagramId={route.diagramId} />
          <ErdPage diagramId={route.diagramId} focusTableId={route.tableId} />
        </div>
      );
      break;
    case "tables":
      content = <TableList />;
      break;
    case "table":
      content = <TableDetail tableId={route.tableId} />;
      break;
    case "tableEdit":
      // 静的モードでは詳細画面にリダイレクトし、閲覧モードである旨を表示（§4.4）
      content = <TableDetail tableId={route.tableId} notice={t("banner.editRedirect")} />;
      break;
    case "columns":
      content = (
        <div className="empty-state">
          <p>{t("columnsPage.serverOnly")}</p>
          <p>
            <Link className="button-link" href={hrefs.tables()}>
              {t("notFound.toTables")}
            </Link>
          </p>
        </div>
      );
      break;
    case "notFound":
      content = <NotFound path={route.path} />;
      break;
  }

  return (
    <div className="app-root">
      <Header currentDiagramId={currentDiagramId} />
      {failedIds.length > 0 && loaded + failed >= total && (
        <div className="error-banner">
          {t("banner.missingTables", { list: failedIds.join(", ") })}
        </div>
      )}
      <main className="app-main">{content}</main>
      {dialog?.type === "table" && <TableDetailDialog tableId={dialog.id} />}
      {dialog?.type === "relation" && <RelationDialog relationId={dialog.id} />}
      {searchOpen && <SearchDialog />}
    </div>
  );
}

/** 描画を止めるバナー（A-04 / §3.6）。中途半端に読んで誤った図を見せない */
function FatalBanner({ fatal }: { fatal: Fatal }) {
  const { t } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode);
  if (fatal.kind === "no-data" || fatal.kind === "empty") {
    // サーバーモードならブートストラップ（A-08）。判定中はどちらの画面も出さない
    if (serverMode === null) {
      return <div className="boot-loading">{t("canvas.loading")}</div>;
    }
    if (serverMode) {
      return <BootstrapScreen />;
    }
  }
  let message: string;
  switch (fatal.kind) {
    case "no-data":
    case "empty":
      message = t("banner.noData");
      break;
    case "bad-data":
      message = t("banner.badData", { file: fatal.file });
      break;
    case "data-older":
      message = t("banner.dataOlder", { version: fatal.version });
      break;
    case "data-newer":
      message = t("banner.dataNewer", { version: fatal.version });
      break;
  }
  return (
    <div className="fatal-screen">
      <div className="fatal-card">
        <h1>{t("app.title")}</h1>
        <p>{message}</p>
      </div>
    </div>
  );
}
