/**
 * ルート切替と全体レイアウト。
 * バージョン不整合・データ欠損時は描画せずバナーのみ表示する（A-04 / §3.6）。
 */
import { useEffect } from "react";
import { ColumnsPage } from "./catalog/ColumnsPage";
import { TableDetail } from "./catalog/TableDetail";
import { TableEdit } from "./catalog/TableEdit";
import { ErdPage } from "./canvas/ErdPage";
import { useI18n } from "./i18n/useI18n";
import { IntrospectPage } from "./introspect/IntrospectPage";
import { flushPendingToast, totalTableCount, useAppStore, type Fatal } from "./model/store";
import { useEditStore } from "./model/editStore";
import { usePageEditStore } from "./model/pageEditStore";
import { BootstrapScreen } from "./ui/BootstrapScreen";
import { EditDialogs, ExternalUpdateBanner, Toasts } from "./ui/EditDialogs";
import { ErdEmpty } from "./ui/ErdEmpty";
import { ExportDialog } from "./ui/ExportDialog";
import { Forbidden } from "./ui/Forbidden";
import { Header } from "./ui/Header";
import { Link } from "./ui/Link";
import { NotFound } from "./ui/NotFound";
import { LeftPanel, usePageTables, useTablesPanelPage } from "./ui/LeftPanel";
import { ConstraintInfoDialog, RelationDialog } from "./ui/DetailDialogs";
import { RelationEditDialog } from "./canvas/RelationEditDialog";
import { PageManageDialog } from "./ui/PageManageDialog";
import { SearchDialog } from "./ui/SearchDialog";
import { TableDetailDialog } from "./ui/TableDetailDialog";
import { WelcomeScreen, WorkspaceNotFound } from "./ui/Workspace";
import { hrefs, replaceRoute, useRoute } from "./ui/router";
import { cx } from "./lib/cx";
import styles from "./App.module.scss";

export function App() {
  const { t } = useI18n();
  const route = useRoute();
  const serverMode = useAppStore((s) => s.serverMode);
  const fatal = useAppStore((s) => s.fatal);
  const ready = useAppStore((s) => s.ready);
  const manifest = useAppStore((s) => s.manifest);
  const index = useAppStore((s) => s.index);
  const dialog = useAppStore((s) => s.dialog);
  const searchOpen = useAppStore((s) => s.searchOpen);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const tableErrors = useAppStore((s) => s.tableErrors);
  const loaded = useAppStore((s) => s.loadedTableCount);
  const failed = useAppStore((s) => s.failedTableCount);
  const total = useAppStore((s) => totalTableCount(s));
  const lastTableId = useAppStore((s) => s.lastTableId);
  const setLastTableId = useAppStore((s) => s.setLastTableId);
  const lastDiagramId = useAppStore((s) => s.lastDiagramId);
  const setLastDiagramId = useAppStore((s) => s.setLastDiagramId);
  const workspaces = useAppStore((s) => s.workspaces);
  const workspaceId = useAppStore((s) => s.workspaceId);
  const workspaceName = workspaces.find((w) => w.id === workspaceId)?.name;
  // URL が指しているテーブル（下の activeTableId と同じもの。フックへ渡すためここで先に作る）
  const routeTableId =
    route.kind === "table" || route.kind === "tableEdit" ? route.tableId : undefined;
  // #/tables の初期表示テーブルを左パネルの見た目と揃えるための材料（下の restoreTableId）。
  // フックなので早期 return より前に置く。パネルと同じ引数で呼び、選ぶページを一致させる
  const tablesPanelLane = useAppStore((s) => s.tablesPanelLane);
  // ページ管理ダイアログ（左パネルのペンで開く）を出しているか
  const pageInfoEditing = useAppStore((s) => s.pageInfoEditing);
  const setPageInfoEditing = useAppStore((s) => s.setPageInfoEditing);
  const tablesPanelPage = useTablesPanelPage(routeTableId);
  const tablesPanelPageTables = usePageTables(tablesPanelPage);
  const exportDiagramId = useEditStore((s) => s.exportDiagramId);
  // 未保存: ER図編集（正味の変更 netDirty）またはテーブル/カラム編集（pageEditStore の dirty）
  const erdUnsaved = useEditStore((s) => s.session === "editing" && s.netDirty);
  const pageUnsaved = usePageEditStore((s) => s.controller?.dirty === true);
  const hasUnsaved = erdUnsaved || pageUnsaved;

  // データリセット・ワークスペース削除はリロードを伴うため、完了通知はここで出す
  useEffect(() => {
    flushPendingToast();
  }, []);

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

  // ページ管理ダイアログ（即時反映）は、パネルが出ていない画面と ER図の編集中には
  // 成立しない（開きっぱなしを残さない／ER編集とは相互排他）。ここで確実に閉じる
  const panelHidden =
    route.kind !== "erd" &&
    route.kind !== "erdHome" &&
    route.kind !== "erdEdit" &&
    route.kind !== "tables" &&
    route.kind !== "table";
  useEffect(() => {
    if (panelHidden || route.kind === "erdEdit") {
      useAppStore.getState().setPageInfoEditing(false);
    }
  }, [panelHidden, route.kind]);

  // 最後に閲覧したテーブルを覚えておき、テーブル一覧を開いたとき復元する（下の tables 分岐）
  const viewedTableId = route.kind === "table" ? route.tableId : null;
  useEffect(() => {
    if (viewedTableId !== null) setLastTableId(viewedTableId);
  }, [viewedTableId, setLastTableId]);

  // 最後に閲覧した ER図ページを覚えておき、#/erd（ページ未指定）を開いたとき復元する
  const viewedDiagramId =
    route.kind === "erd" || route.kind === "erdEdit" ? route.diagramId : null;
  useEffect(() => {
    if (viewedDiagramId !== null && viewedDiagramId !== undefined) {
      setLastDiagramId(viewedDiagramId);
    }
  }, [viewedDiagramId, setLastDiagramId]);

  // 編集中に未保存があれば HTML タイトルに * を付ける（他タブでも一目で分かるように）。
  // 基準名はワークスペース名（どの DB を開いているタブかをタブ見出しで区別できるようにする）
  useEffect(() => {
    const base =
      workspaceName !== undefined && workspaceName !== ""
        ? `${workspaceName} - ${t("app.title")}`
        : t("app.title");
    document.title = hasUnsaved ? `* ${base}` : base;
  }, [hasUnsaved, workspaceName, t]);

  // 空プロジェクトからの逆生成（§3.6「既存のスキーマから生成する」）。
  // データはまだ無いが、それを作るための画面なので開けなければならない
  const bootstrapping =
    fatal !== null &&
    serverMode === true &&
    (fatal.kind === "no-data" || fatal.kind === "empty") &&
    route.kind === "introspect";

  if (fatal !== null && !bootstrapping) {
    // welcome / ブートストラップ画面でも完了通知は出す（削除の直後はここに着地する）
    return (
      <>
        <FatalBanner fatal={fatal} />
        <Toasts />
      </>
    );
  }
  if (!ready && !bootstrapping) {
    return <div className={styles.bootLoading}>{t("canvas.loading")}</div>;
  }

  const firstDiagram = manifest?.diagrams?.[0]?.id;
  // 最後に閲覧したページが今も存在すればそれを、無ければ先頭を復元する（#/erd を開いたとき）
  const restoreDiagramId =
    lastDiagramId !== null && (manifest?.diagrams ?? []).some((d) => d.id === lastDiagramId)
      ? lastDiagramId
      : firstDiagram;
  const currentDiagramId =
    route.kind === "erd" || route.kind === "erdEdit" ? route.diagramId : undefined;
  // ページが0件の #/erd でも編集セッションを開始できなければ、ページを作れない
  const onErdRoute =
    route.kind === "erd" || route.kind === "erdHome" || route.kind === "erdEdit";
  const failedIds = Object.keys(tableErrors);

  // テーブル画面は常に1件選択（回答E）。素の #/tables は先頭テーブルへ振り替える
  const firstTableId = [...(index?.tables ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, "ja"),
  )[0]?.id;
  // 前回のテーブルが無いときの着地点。左パネルが「ページ」レーンなら、そこに並んでいる
  // アクティブなページ（＝業務領域）の先頭テーブルを開く。全テーブルの先頭だと、
  // 左の一覧に無いテーブルの詳細が出てしまい不自然（ページに1件も無ければ従来どおり先頭）
  const panelFirstTableId =
    tablesPanelLane === "pages" ? tablesPanelPageTables[0]?.id : undefined;
  // 最後に閲覧したテーブルが今も存在すればそれを、無ければ上の既定を開く（回答E を維持）
  const restoreTableId =
    lastTableId !== null && (index?.tables ?? []).some((tt) => tt.id === lastTableId)
      ? lastTableId
      : (panelFirstTableId ?? firstTableId);

  // 左パネルの表示対象（回答2: ER用・テーブル用の2インスタンスを常時マウントし表示を出し分ける）。
  // テーブル編集中は隠す（編集フォームに集中させ、そこから他テーブルへ飛ばせないようにする）
  const panelScope: "erd" | "tables" | null = onErdRoute
    ? "erd"
    : route.kind === "tables" || route.kind === "table"
      ? "tables"
      : null;
  const activeTableId =
    route.kind === "erd" || route.kind === "erdEdit" ? route.tableId : routeTableId;

  let content: React.ReactNode;
  switch (route.kind) {
    case "home":
      // 既定画面は常に ER図。最後に閲覧したページ（無ければ先頭）を復元する。
      // ページが1枚も無い場合（逆生成の直後）は #/erd が作成の導線を出す
      // （テーブル一覧へ逃がすと、ページを作る画面に到達できない）
      replaceRoute(restoreDiagramId !== undefined ? hrefs.erd(restoreDiagramId) : hrefs.erdHome());
      content = null;
      break;
    case "erdHome":
      // 最後に閲覧したページ（無ければ先頭）を復元する
      if (restoreDiagramId !== undefined) {
        replaceRoute(hrefs.erd(restoreDiagramId));
        content = null;
      } else {
        content = <ErdEmpty />;
      }
      break;
    case "erd":
      content = <ErdPage diagramId={route.diagramId} focusTableId={route.tableId} />;
      break;
    case "erdEdit":
      // 編集ルート。ER図は静的モードでも編集できる（保存不可の警告つき。§9.7）。
      // 左パネルからテーブルを選んだときも編集を抜けずにフォーカスできる（tableId 付き）
      content = <ErdPage diagramId={route.diagramId} focusTableId={route.tableId} />;
      break;
    case "tables":
      // 一覧と詳細を統合（案B）。未選択状態は作らず、最後に閲覧したテーブル
      // （無ければ先頭）を開く（回答E）
      if (restoreTableId !== undefined) {
        replaceRoute(hrefs.table(restoreTableId));
        content = null;
      } else {
        content = (
          <div className="empty-state">
            <p>{t("tables.empty")}</p>
            <p className="muted">{t("tables.emptyHint")}</p>
          </div>
        );
      }
      break;
    case "table":
      content = <TableDetail tableId={route.tableId} />;
      break;
    case "tableEdit":
      // 静的モードでは詳細画面にリダイレクトし、閲覧モードである旨を表示（§4.4）
      if (serverMode === true) {
        content = <TableEdit tableId={route.tableId} />;
      } else if (serverMode === null) {
        content = <div className={styles.bootLoading}>{t("canvas.loading")}</div>;
      } else {
        content = <TableDetail tableId={route.tableId} notice={t("banner.editRedirect")} />;
      }
      break;
    case "columns":
      // 閲覧ルート。静的モードでも閲覧のみ可能（P-03。静・編）。
      // 検索モーダルからの遷移時は focusColumn / focusMatch で絞り込む（回答A）
      content = (
        <ColumnsPage
          editing={false}
          focusColumn={route.focusColumn}
          focusMatch={route.focusMatch}
        />
      );
      break;
    case "columnsEdit":
      // 編集ルート。静的モードでは閲覧（#/columns）へリダイレクト（§4.4）
      if (serverMode === true) {
        content = <ColumnsPage editing={true} />;
      } else if (serverMode === null) {
        content = <div className={styles.bootLoading}>{t("canvas.loading")}</div>;
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
        content = <div className={styles.bootLoading}>{t("canvas.loading")}</div>;
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
    <div className={styles.appRoot}>
      <Header currentDiagramId={currentDiagramId} />
      {failedIds.length > 0 && loaded + failed >= total && (
        <div className="error-banner">
          {t("banner.missingTables", { list: failedIds.join(", ") })}
        </div>
      )}
      <ExternalUpdateBanner />
      <main className={styles.appMain} data-testid="app-main">
        {/* ER用・テーブル用パネルは常時マウントし、表示のみ切り替える（回答2）。
            アンマウントしないため、画面を往復してもレーン選択・フィルタ・検索が保持される */}
        <div
          className={cx(styles.panelSlot, panelScope !== "erd" && styles.hidden)}
          data-testid="panel-slot"
          data-hidden={panelScope !== "erd" ? "true" : undefined}
        >
          <LeftPanel scope="erd" currentDiagramId={currentDiagramId} activeTableId={activeTableId} />
        </div>
        <div
          className={cx(styles.panelSlot, panelScope !== "tables" && styles.hidden)}
          data-testid="panel-slot"
          data-hidden={panelScope !== "tables" ? "true" : undefined}
        >
          <LeftPanel scope="tables" activeTableId={activeTableId} />
        </div>
        <div className={styles.appContent}>{content}</div>
      </main>
      {dialog?.type === "table" && <TableDetailDialog tableId={dialog.id} />}
      {dialog?.type === "relation" && <RelationDialog relationId={dialog.id} />}
      {dialog?.type === "relationEdit" && <RelationEditDialog relationId={dialog.id} />}
      {dialog?.type === "constraint" && (
        <ConstraintInfoDialog tableId={dialog.tableId} kind={dialog.kind} at={dialog.at} />
      )}
      {searchOpen && <SearchDialog />}
      {/* ページ管理（I-01〜I-03）。左パネルのペンから開く。パネルは ER用・テーブル用の2つが
          同時にマウントされているため、ダイアログはパネルの中ではなくここから1つだけ出す */}
      {pageInfoEditing && <PageManageDialog onClose={() => setPageInfoEditing(false)} />}
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
  // ワークスペースが無い / URL が存在しないワークスペースを指している（§4 / §10）
  if (fatal.kind === "no-workspace") {
    if (serverMode === null) {
      return <div className={styles.bootLoading}>{t("canvas.loading")}</div>;
    }
    return <WelcomeScreen />;
  }
  if (fatal.kind === "workspace-not-found") {
    return <WorkspaceNotFound id={fatal.id} />;
  }
  // トークン不一致（§8.5）。データ配信ごと拒まれているので、閲覧も含めて何も出せない
  if (fatal.kind === "forbidden") {
    return <Forbidden />;
  }
  if (fatal.kind === "no-data" || fatal.kind === "empty") {
    // サーバーモードならブートストラップ（A-08）。判定中はどちらの画面も出さない
    if (serverMode === null) {
      return <div className={styles.bootLoading}>{t("canvas.loading")}</div>;
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
