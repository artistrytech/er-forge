/**
 * ルート切替と全体レイアウト。
 * バージョン不整合・データ欠損時は描画せずバナーのみ表示する（A-04 / §3.6）。
 */
import { useEffect } from "react";
import { ColumnsPage } from "./catalog/ColumnsPage";
import { TableDetail } from "./catalog/TableDetail";
import { TableEdit } from "./catalog/TableEdit";
import { TableList } from "./catalog/TableList";
import { ErdPage } from "./canvas/ErdPage";
import { useI18n } from "./i18n/useI18n";
import { IntrospectPage } from "./introspect/IntrospectPage";
import { totalTableCount, useAppStore, type Fatal } from "./model/store";
import { useEditStore } from "./model/editStore";
import { BootstrapScreen } from "./ui/BootstrapScreen";
import { EditDialogs, ExternalUpdateBanner, Toasts } from "./ui/EditDialogs";
import { ErdEmpty } from "./ui/ErdEmpty";
import { ExportDialog } from "./ui/ExportDialog";
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
  const serverMode = useAppStore((s) => s.serverMode);
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
  const exportDiagramId = useEditStore((s) => s.exportDiagramId);

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

  // 編集セッションはルートに追従する（H-10 / §4.4）。編集ルート（#/erd/<id>/edit）に
  // いる間だけ ER図が編集中になる。離脱の未保存ガードは ErdPage が持つ（そこで confirm が
  // 通ってからここへ来る）ため、erdEdit を離れたら安全に閲覧へ戻せる
  useEffect(() => {
    if (route.kind === "erdEdit") {
      useEditStore.getState().enterEditing();
    } else {
      useEditStore.getState().leaveEditing();
    }
  }, [route.kind]);

  // 空プロジェクトからの逆生成（§3.6「既存のスキーマから生成する」）。
  // データはまだ無いが、それを作るための画面なので開けなければならない
  const bootstrapping =
    fatal !== null &&
    serverMode === true &&
    (fatal.kind === "no-data" || fatal.kind === "empty") &&
    route.kind === "introspect";

  if (fatal !== null && !bootstrapping) {
    return <FatalBanner fatal={fatal} />;
  }
  if (!ready && !bootstrapping) {
    return <div className="boot-loading">{t("canvas.loading")}</div>;
  }

  const firstDiagram = manifest?.diagrams?.[0]?.id;
  const currentDiagramId =
    route.kind === "erd" || route.kind === "erdEdit" ? route.diagramId : undefined;
  // ページが0件の #/erd でも編集セッションを開始できなければ、ページを作れない
  const onErdRoute =
    route.kind === "erd" || route.kind === "erdHome" || route.kind === "erdEdit";
  const failedIds = Object.keys(tableErrors);

  let content: React.ReactNode;
  switch (route.kind) {
    case "home":
      // 既定画面は常に ER図。ページが1枚も無い場合（逆生成の直後）は #/erd が
      // 作成の導線を出す（テーブル一覧へ逃がすと、ページを作る画面に到達できない）
      replaceRoute(firstDiagram !== undefined ? hrefs.erd(firstDiagram) : hrefs.erdHome());
      content = null;
      break;
    case "erdHome":
      if (firstDiagram !== undefined) {
        replaceRoute(hrefs.erd(firstDiagram));
        content = null;
      } else {
        content = (
          <div className="erd-layout">
            <Sidebar />
            <ErdEmpty />
          </div>
        );
      }
      break;
    case "erd":
      content = (
        <div className="erd-layout">
          <Sidebar currentDiagramId={route.diagramId} />
          <ErdPage diagramId={route.diagramId} focusTableId={route.tableId} />
        </div>
      );
      break;
    case "erdEdit":
      // 編集ルート。ER図は静的モードでも編集できる（保存不可の警告つき。§9.7）
      content = (
        <div className="erd-layout">
          <Sidebar currentDiagramId={route.diagramId} />
          <ErdPage diagramId={route.diagramId} />
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
      if (serverMode === true) {
        content = <TableEdit tableId={route.tableId} />;
      } else if (serverMode === null) {
        content = <div className="boot-loading">{t("canvas.loading")}</div>;
      } else {
        content = <TableDetail tableId={route.tableId} notice={t("banner.editRedirect")} />;
      }
      break;
    case "columns":
      // 閲覧ルート。静的モードでも閲覧のみ可能（P-03。静・編）
      content = <ColumnsPage editing={false} />;
      break;
    case "columnsEdit":
      // 編集ルート。静的モードでは閲覧（#/columns）へリダイレクト（§4.4）
      if (serverMode === true) {
        content = <ColumnsPage editing={true} />;
      } else if (serverMode === null) {
        content = <div className="boot-loading">{t("canvas.loading")}</div>;
      } else {
        replaceRoute(hrefs.columns());
        content = null;
      }
      break;
    case "introspect":
      // 逆生成はサーバー API に依存する（静的モードには手段がない。§9.6）
      if (serverMode === true) {
        content = <IntrospectPage />;
      } else if (serverMode === null) {
        content = <div className="boot-loading">{t("canvas.loading")}</div>;
      } else {
        content = (
          <div className="empty-state">
            <p>{t("introspect.serverOnly")}</p>
            <p>
              <Link className="button-link" href={hrefs.tables()}>
                {t("notFound.toTables")}
              </Link>
            </p>
          </div>
        );
      }
      break;
    case "notFound":
      content = <NotFound path={route.path} />;
      break;
  }

  return (
    <div className="app-root">
      <Header currentDiagramId={currentDiagramId} onErdRoute={onErdRoute} />
      {failedIds.length > 0 && loaded + failed >= total && (
        <div className="error-banner">
          {t("banner.missingTables", { list: failedIds.join(", ") })}
        </div>
      )}
      <ExternalUpdateBanner />
      <main className="app-main">{content}</main>
      {dialog?.type === "table" && <TableDetailDialog tableId={dialog.id} />}
      {dialog?.type === "relation" && <RelationDialog relationId={dialog.id} />}
      {searchOpen && <SearchDialog />}
      <EditDialogs />
      {exportDiagramId !== null && <ExportDialog diagramId={exportDiagramId} />}
      <Toasts />
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
