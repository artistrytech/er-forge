/**
 * 左パネル（.request/2027/07/17.md）。ER画面・テーブル画面の左に置く2レーン構成。
 * **両画面でデザインを完全に一致させる**ため、3レーンとも同一コンポーネント・同一 CSS を
 * scope 違いで共用する（差は挙動のみ: 遷移先と、ER×編集時だけ出る配置編集の導線）。
 *
 * - 64px のアイコンレール（ページ / 全て / 検索）＋隣接する一覧パネル。
 * - 「ページ」: ページ一覧＋選択ページのテーブル＋未配置トレイ（{@link PagesLane}）。
 * - 「全て」: 全テーブル＋テーブル名フィルタ。
 * - 「検索」: カラム・タグ含む総合検索（一致条件つき）。
 *
 * レーン選択・フィルタ・検索クエリは各インスタンスのローカル状態。App が ER 用・
 * テーブル用の2インスタンスを常時マウントしたまま表示を出し分けるため、画面を往復しても
 * 状態が保持される（回答2）。ただしテーブル用のレーンと「ページ」レーンの選択ページだけは
 * appStore に置く（#/tables を開いたときの初期表示テーブルを App が同じ基準で選ぶため）。
 *
 * 「全て」の絞り込みと「検索」のワード・一致条件は、さらに sessionStorage へ預ける。
 * レーンの中身はレーンを切り替えると再マウントされ、ローカル状態だけでは打った言葉が
 * 消えてしまうため（{@link useSessionState}）。
 *
 * テーブルを選択したときの遷移（回答3 / 6）:
 * - ER画面: 現在のページにあればフォーカス、別ページにあればそのページでフォーカス、
 *   未配置なら詳細ダイアログ（ダブルクリック相当）。**編集中は編集ルートのままフォーカスする**。
 * - テーブル画面: 右ペインに詳細（URL にテーブルを埋め込む）。ドキュメントモード（R-01）中は
 *   詳細へ飛ばず、文書内のその見出しへスクロールする（R-03）。
 *
 * テーブル用のインスタンスは、各レーンが**今並べているテーブル**を appStore.tablesPanelList に
 * 書く。ドキュメントモードはそれを範囲として上から描く（範囲を選ぶ UI を右ペインに持たない）。
 *
 * 編集の導線は2つあり、どちらか一方しか有効にならない:
 * - ER図の配置編集（editStore のセッション。保存が要る）… 未配置トレイからの配置・ドラッグ
 * - ページの管理（「ページ」見出しのペンで開くダイアログ。**即時にファイルへ書かれる**）…
 *   追加・改名・並替・削除。**この一覧自体は編集用の見た目に変わらない**（PageManageDialog）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { useCanvasStore } from "../canvas/canvasStore";
import { TABLE_DND_TYPE } from "../canvas/ErdPage";
import { colorAttr } from "../model/colors";
import { useEditStore } from "../model/editStore";
import { formatName, resolveIndexTableName, type NameDisplay } from "../model/logicalName";
import { usePageEditStore } from "../model/pageEditStore";
import { searchAll, type MatchMode } from "../model/search";
import { useAppStore, type PanelLane } from "../model/store";
import type { IndexTable } from "../model/types";
import { Dialog } from "./Dialog";
import { PenIcon } from "./icons";
import { Link } from "./Link";
import { hrefs, useRoute } from "./router";
import { cx } from "../lib/cx";
import { useSessionState } from "../lib/useSessionState";
import styles from "./LeftPanel.module.scss";

export type PanelScope = "erd" | "tables";
type Lane = PanelLane;

/** 未配置の疑似ページを表す選択センチネル（回答3） */
const UNPLACED = "__unplaced__";

/**
 * 「全て」の絞り込み・「検索」のワードと一致条件の保持キー（**タブ単位**）。
 *
 * レーンを切り替えるとレーンのコンポーネントは再マウントされ、そのままだと打った言葉が
 * 消える。打ち直しを強いないよう sessionStorage に預けて、戻ったときに復元する。
 *
 * ER用・テーブル用の2インスタンスは**別々に持つ**（両方が同時にマウントされており、
 * 一方で打った言葉がもう一方の一覧を勝手に絞ると、見えていないところで件数が変わる）。
 * ワークスペースでは分けない（ID と違って言葉はワークスペースをまたいで意味を持つし、
 * 復元された言葉は入力欄にそのまま見えている）。
 */
const filterKey = (scope: PanelScope): string => `erd-panel-filter:${scope}`;
const queryKey = (scope: PanelScope): string => `erd-panel-query:${scope}`;
const modeKey = (scope: PanelScope): string => `erd-panel-match:${scope}`;

interface LeftPanelProps {
  scope: PanelScope;
  /** ER画面: 現在のページ */
  currentDiagramId?: string;
  /** ER画面: フォーカス中テーブル / テーブル画面: 選択中テーブル */
  activeTableId?: string;
}

export function LeftPanel({ scope, currentDiagramId, activeTableId }: LeftPanelProps) {
  // ER用はインスタンス内で完結。テーブル用は App も見る（#/tables の初期表示テーブル）ので store
  const [erdLane, setErdLane] = useState<Lane>("pages");
  const tablesLane = useAppStore((s) => s.tablesPanelLane);
  const setTablesLane = useAppStore((s) => s.setTablesPanelLane);
  const lane = scope === "erd" ? erdLane : tablesLane;
  const setLane = scope === "erd" ? setErdLane : setTablesLane;
  // ER画面では、キャンバス上でノードを選んだときも一覧の選択を追随させる（双方向）。
  // 一覧 → キャンバスは URL のフォーカス経由、キャンバス → 一覧はこの選択状態経由になる
  const selection = useCanvasStore((s) => s.selection);
  const active =
    scope === "erd"
      ? selection?.type === "node"
        ? selection.id
        : undefined
      : activeTableId;
  return (
    <div className={styles.leftPanel}>
      <IconRail lane={lane} onChange={setLane} />
      <div className={styles.lpBody}>
        {lane === "pages" && (
          <PagesLane scope={scope} currentDiagramId={currentDiagramId} activeTableId={active} />
        )}
        {lane === "all" && (
          <AllLane scope={scope} currentDiagramId={currentDiagramId} activeTableId={active} />
        )}
        {lane === "search" && <SearchLane scope={scope} activeTableId={active} />}
      </div>
    </div>
  );
}

/**
 * テーブルがどのページに載っているか。index.js の tables[].diagrams は**保存後にしか
 * 更新されない**ため、それだけを見ると保存前の配置・除去が一覧に反映されない
 * （配置したのに未配置トレイに残り続ける）。読み込み済みのページの view（committed + pending）
 * で上書きし、未保存の追加・除去も一覧に効かせる。
 */
function usePlacement(): Map<string, string[]> {
  const index = useAppStore((s) => s.index);
  const diagrams = useAppStore((s) => s.diagrams);
  return useMemo(() => {
    const loaded = Object.entries(diagrams);
    const map = new Map<string, string[]>();
    for (const it of index?.tables ?? []) {
      const pages = new Set(it.diagrams ?? []);
      for (const [diagramId, diagram] of loaded) {
        if (diagram.nodes?.[it.id] !== undefined) pages.add(diagramId);
        else pages.delete(diagramId);
      }
      map.set(it.id, [...pages]);
    }
    return map;
  }, [index, diagrams]);
}

/** ページ一覧（表示順）。左パネルと #/tables の初期表示テーブルの決定で同じ並びを使う */
function useSortedDiagrams() {
  const manifest = useAppStore((s) => s.manifest);
  return useMemo(
    () => [...(manifest?.diagrams ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [manifest],
  );
}

/**
 * テーブル画面側の左パネルの「ページ」レーンで選択中のページ。
 * 未選択（初回）と、消えたページを指したままの場合は表示中のテーブルから決める。
 * 未配置の疑似ページはそのまま返す（尽きたら PagesLane が実ページへ戻す）。
 *
 * `activeTableId` は URL が指しているテーブル。テーブルを直接指定して開いたとき
 * （`#/w/<ws>/tables/<id>` の直リンク・ブックマーク）に一律で先頭ページを選ぶと、
 * **左の一覧に無いテーブルを開いている**状態になり、選択とページ内容が食い違う。
 * 自分で一度ページを選べば（store に載る）以後はその選択が優先される。
 */
export function useTablesPanelPage(activeTableId?: string): string | undefined {
  const stored = useAppStore((s) => s.tablesPanelPage);
  const diagrams = useSortedDiagrams();
  const placement = usePlacement();
  if (stored === UNPLACED) return UNPLACED;
  if (stored !== null && diagrams.some((d) => d.id === stored)) return stored;
  if (activeTableId !== undefined && placement.has(activeTableId)) {
    // 「先頭」はページ一覧に並んでいる順（manifest の order）で数える
    const pages = placement.get(activeTableId) ?? [];
    const onPage = diagrams.find((d) => pages.includes(d.id));
    // どのページにも載っていないテーブルは未配置トレイに並ぶ。そちらを開く
    return onPage?.id ?? UNPLACED;
  }
  return diagrams[0]?.id;
}

/**
 * 「ページ」レーンの一覧に並ぶテーブル（選択中ページの配置テーブル / 未配置トレイの中身）。
 * PagesLane の表示と、#/tables を開いたときの初期表示テーブル（App）で基準を揃えるために切り出す。
 */
export function usePageTables(selectedPage: string | undefined): IndexTable[] {
  const index = useAppStore((s) => s.index);
  const placement = usePlacement();
  return useMemo(() => {
    if (selectedPage === undefined) return [];
    const sorted = [...(index?.tables ?? [])].sort((a, b) => a.name.localeCompare(b.name, "ja"));
    return selectedPage === UNPLACED
      ? sorted.filter((it) => (placement.get(it.id) ?? []).length === 0)
      : sorted.filter((it) => (placement.get(it.id) ?? []).includes(selectedPage));
  }, [index, placement, selectedPage]);
}

/**
 * レーンが並べているテーブルをドキュメントモードの範囲として公開する（R-01 / INV-1）。
 * テーブル用のインスタンスだけが書く（ER用は別の絞り込みを持っており、混ぜると
 * 見えていないパネルの言葉で右ペインの範囲が変わる）。
 */
function usePublishPanelList(enabled: boolean, ids: string[], label: string): void {
  const setList = useAppStore((s) => s.setTablesPanelList);
  const key = ids.join("\n");
  useEffect(() => {
    if (enabled) setList({ ids: key === "" ? [] : key.split("\n"), label });
  }, [enabled, key, label, setList]);
}

/**
 * テーブル画面での選択先。表示モード（詳細 / ドキュメント）を保ったまま URL をそのテーブルにし、
 * 右ペインの連続表示にその見出しへスクロールさせる（R-03）
 */
function useTablesTarget(): (tableId: string) => void {
  const docMode = useRoute().kind === "tableDoc";
  return useCallback(
    (tableId: string) => {
      location.hash = docMode ? hrefs.tableDoc(tableId) : hrefs.table(tableId);
      // 同じテーブルを続けて押しても効くように（同じハッシュへの代入は hashchange を起こさない）
      useAppStore.getState().requestDocScroll(tableId);
    },
    [docMode],
  );
}

/**
 * 選択された行を一覧の見える位置へ出す（R-03。右ペインのスクロールに左の一覧も追随する）。
 * nearest なので、すでに見えていれば一覧は動かない
 */
function RevealLi({
  active,
  ...rest
}: React.LiHTMLAttributes<HTMLLIElement> & { active: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return <li ref={ref} {...rest} />;
}

// ------------------------------------------------------------------ アイコンレール

function IconRail({ lane, onChange }: { lane: Lane; onChange: (l: Lane) => void }) {
  const { t } = useI18n();
  const items: { id: Lane; label: string; icon: React.ReactNode }[] = [
    { id: "pages", label: t("panel.lane.pages"), icon: <PagesIcon /> },
    { id: "all", label: t("panel.lane.all"), icon: <AllIcon /> },
    { id: "search", label: t("panel.lane.search"), icon: <SearchIcon /> },
  ];
  return (
    <div className={styles.lpRail} role="tablist" aria-orientation="vertical">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={lane === it.id}
          className={cx(styles.lpRailItem, lane === it.id && styles.active)}
          title={it.label}
          data-testid={`lane-${it.id}`}
          onClick={() => onChange(it.id)}
        >
          {it.icon}
          <span className={styles.lpRailLabel}>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * ER図のページを開く URL。**編集中は編集ルート（.../edit）を保つ**（左パネルを触るたびに
 * 編集が終わってしまわないように。編集ルートを離れると App がセッションを閉じる）。
 */
function useErdHref(): (diagramId: string, tableId?: string) => string {
  const editing = useEditStore((s) => s.session === "editing");
  return useCallback(
    (diagramId: string, tableId?: string) =>
      editing ? hrefs.erdEdit(diagramId, tableId) : hrefs.erd(diagramId, tableId),
    [editing],
  );
}

/**
 * 「ページ」レーンからのテーブル選択（従来通り）。ER図では現在のページでフォーカス、
 * 別ページにあればそのページでフォーカス、未配置は詳細ダイアログ（回答3 / 6）。
 */
function useTableSelect(scope: PanelScope, currentDiagramId?: string): (tableId: string) => void {
  const openDialog = useAppStore((s) => s.openDialog);
  const placement = usePlacement();
  const erdHref = useErdHref();
  const tablesTarget = useTablesTarget();
  return useCallback(
    (tableId: string) => {
      if (scope === "tables") {
        tablesTarget(tableId);
        return;
      }
      const diagrams = placement.get(tableId) ?? [];
      const otherPage = diagrams[0];
      if (currentDiagramId !== undefined && diagrams.includes(currentDiagramId)) {
        location.hash = erdHref(currentDiagramId, tableId); // 現在のページでフォーカス
      } else if (otherPage !== undefined) {
        location.hash = erdHref(otherPage, tableId); // 別ページでフォーカス（回答6）
      } else {
        openDialog({ type: "table", id: tableId }); // 未配置は詳細ダイアログ（回答3）
      }
    },
    [scope, currentDiagramId, placement, erdHref, openDialog, tablesTarget],
  );
}

/**
 * 「全て」「検索」レーンからのテーブル選択。ER図では配置ページ数で分岐する:
 * - 未配置(0ページ): 詳細ダイアログ（従来通り）
 * - 1ページ: そのページを開いてノードを選択状態にする
 * - 複数ページ: ページ選択ダイアログののち、そのページを開いてノードを選択する
 * テーブル画面では従来どおり右ペインに詳細を表示する。
 */
function useListTableSelect(scope: PanelScope): {
  select: (tableId: string) => void;
  pickerNode: React.ReactNode;
} {
  const openDialog = useAppStore((s) => s.openDialog);
  const placement = usePlacement();
  const erdHref = useErdHref();
  const tablesTarget = useTablesTarget();
  const [picker, setPicker] = useState<{ tableId: string; pages: string[] } | null>(null);

  const select = useCallback(
    (tableId: string) => {
      if (scope === "tables") {
        tablesTarget(tableId);
        return;
      }
      const pages = placement.get(tableId) ?? [];
      if (pages.length === 0) {
        openDialog({ type: "table", id: tableId }); // 未配置は詳細ダイアログ
      } else if (pages.length === 1) {
        location.hash = erdHref(pages[0]!, tableId); // 1ページはそのページでフォーカス
      } else {
        setPicker({ tableId, pages }); // 複数ページはダイアログで選ばせる
      }
    },
    [scope, placement, erdHref, openDialog, tablesTarget],
  );

  const pickerNode =
    picker !== null ? (
      <PagePickerDialog
        tableId={picker.tableId}
        pages={picker.pages}
        onPick={(page) => {
          location.hash = erdHref(page, picker.tableId);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
    ) : null;

  return { select, pickerNode };
}

/** 複数ページに配置されたテーブルの、開くページを選ばせるダイアログ */
function PagePickerDialog({
  tableId,
  pages,
  onPick,
  onClose,
}: {
  tableId: string;
  pages: string[];
  onPick: (page: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const manifest = useAppStore((s) => s.manifest);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const it = index?.tables?.find((x) => x.id === tableId);
  const label = it ? formatName(resolveIndexTableName(it), it.name, nameDisplay) : tableId;
  const pageTitle = (id: string): string =>
    manifest?.diagrams?.find((d) => d.id === id)?.title ?? id;
  return (
    <Dialog title={t("panel.pickPageTitle")} onClose={onClose}>
      <p className="muted">{t("panel.pickPageHint", { table: label })}</p>
      <ul className={styles.pagePickList}>
        {pages.map((p) => (
          <li key={p}>
            <button type="button" className={styles.pagePickItem} onClick={() => onPick(p)}>
              {pageTitle(p)}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

// ------------------------------------------------------------------ 行のホバーで出る編集への近道

/**
 * テーブル行にホバーしたときだけ出る、テーブル編集画面（O-03）への直行リンク。
 * 一覧のどのレーンからでも「見つけて、すぐ直す」ができるようにするためのもの。
 *
 * **編集モード中は出さない。** 編集ルートを離れるとセッションが終わる（ER図の未保存の
 * 配置は破棄される）ため、編集中に別の編集画面へ飛べる導線を置くと事故になる。
 * 静的モードでも出さない（編集ルートは詳細画面へリダイレクトされる）。
 */
function TableEditLink({ tableId }: { tableId: string }) {
  const { t } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode === true);
  const erdEditing = useEditStore((s) => s.session === "editing");
  const pageInfoEditing = useAppStore((s) => s.pageInfoEditing);
  // テーブル編集・カラム辞書編集の最中（それらの画面がコントローラを登録している）
  const pageEditing = usePageEditStore((s) => s.controller !== null);

  if (!serverMode || erdEditing || pageInfoEditing || pageEditing) return null;
  return (
    <Link
      className={cx("sidebar-icon-button", styles.lpEditLink)}
      href={hrefs.tableEdit(tableId)}
      data-testid="lp-edit-table"
      title={t("panel.editTable")}
      aria-label={t("panel.editTable")}
    >
      <PenIcon size={13} strokeWidth={2} />
    </Link>
  );
}

// ================================================================== 「ページ」レーン（両 scope 共通）

function PagesLane({
  scope,
  currentDiagramId,
  activeTableId,
}: {
  scope: PanelScope;
  currentDiagramId?: string;
  activeTableId?: string;
}) {
  const { t } = useI18n();
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const serverMode = useAppStore((s) => s.serverMode === true);
  const editing = useEditStore((s) => s.session === "editing");
  const pageInfoEditing = useAppStore((s) => s.pageInfoEditing);
  const placement = usePlacement();
  const onSelect = useTableSelect(scope, currentDiagramId);
  const erdHref = useErdHref();
  // 未配置トレイからの配置は ER図の編集セッション側の操作（ページ管理とは別物）
  const canPlace = scope === "erd" && editing && serverMode;

  const diagrams = useSortedDiagrams();

  // 選択中ページ。ER はルート（現在のページ）に追従、テーブルは store（#/tables の初期表示
  // テーブルを App が同じページから選ぶため、ローカル状態にはしない）
  const [erdPage, setErdPage] = useState<string | undefined>(currentDiagramId ?? diagrams[0]?.id);
  const tablesPage = useTablesPanelPage(activeTableId);
  const setTablesPage = useAppStore((s) => s.setTablesPanelPage);
  const selectedPage = scope === "erd" ? erdPage : tablesPage;
  const setSelectedPage = useCallback(
    (id: string | undefined) => {
      if (scope === "erd") setErdPage(id);
      else setTablesPage(id ?? null);
    },
    [scope, setTablesPage],
  );
  useEffect(() => {
    if (scope === "erd" && currentDiagramId !== undefined) setErdPage(currentDiagramId);
  }, [scope, currentDiagramId]);

  const tableCountByDiagram = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pages of placement.values()) {
      for (const d of pages) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return counts;
  }, [placement]);

  const unplaced = usePageTables(UNPLACED);
  const pageTables = usePageTables(selectedPage === UNPLACED ? undefined : selectedPage);

  // 未配置の疑似ページを選択中に未配置が尽きたら、実ページの表示へ戻す
  // （配置し終えたら未配置トレイは消える。K-12 §7.1）
  const showTray = selectedPage === UNPLACED && unplaced.length > 0;
  // ドキュメントモードの範囲（R-01）。未配置トレイを見せている間はトレイ側が公開する
  const pageIds = useMemo(() => pageTables.map((it) => it.id), [pageTables]);
  const pageLabel =
    selectedPage === UNPLACED
      ? t("doc.range.unplaced")
      : t("doc.range.page", {
          name: diagrams.find((d) => d.id === selectedPage)?.title ?? selectedPage ?? "",
        });
  usePublishPanelList(scope === "tables" && !showTray, pageIds, pageLabel);
  useEffect(() => {
    if (selectedPage === UNPLACED && unplaced.length === 0) {
      setSelectedPage(scope === "erd" ? (currentDiagramId ?? diagrams[0]?.id) : diagrams[0]?.id);
    }
  }, [selectedPage, unplaced.length, scope, currentDiagramId, diagrams, setSelectedPage]);

  const selectPage = (id: string): void => {
    setSelectedPage(id);
    // ER図では実ページの選択でそのページへ遷移（現在のページを切り替える）。
    // 編集中は編集ルートのまま切り替える（ページを選ぶだけで編集が終わらないように）。
    // 未配置の疑似ページは見た目上のページ切り替えをしない（回答D）
    if (scope === "erd" && id !== UNPLACED) location.hash = erdHref(id);
  };

  return (
    <div className={cx(styles.lpLane, styles.lpLaneSplit)}>
      <div className={styles.sidebarSection}>
        <div className={styles.sidebarHeading}>
          {t("sidebar.pages")}
          {serverMode && (
            <span className={styles.pageHeadActions}>
              <PageManageButton open={pageInfoEditing} lockedByErd={editing} />
            </span>
          )}
        </div>
        {/* ページが増えても下の「テーブル」が押し出されないよう、一覧の側だけをスクロールさせる（.lp-lane-split） */}
        <ul className={styles.pageList} data-testid="page-list">
          {diagrams.map((d) => (
            <li
              key={d.id}
              className={styles.sidebarPageRow}
              data-testid="page-row"
              data-active={d.id === selectedPage ? "true" : undefined}
            >
              <button
                type="button"
                className={cx(styles.lpPageRow, d.id === selectedPage && styles.active)}
                onClick={() => selectPage(d.id)}
              >
                <span className={styles.lpItemName}>{d.title ?? d.id}</span>
                <span className={styles.sidebarCount}>
                  {t("sidebar.tableCount", { n: tableCountByDiagram.get(d.id) ?? 0 })}
                </span>
              </button>
            </li>
          ))}
          {unplaced.length > 0 && (
            <li>
              <button
                type="button"
                data-testid="unplaced-page"
                data-active={selectedPage === UNPLACED ? "true" : undefined}
                className={cx(styles.lpPageRow, selectedPage === UNPLACED && styles.active)}
                onClick={() => selectPage(UNPLACED)}
              >
                <span className={cx(styles.lpItemName, "muted")}>{t("sidebar.unplaced")}</span>
                <span className={styles.sidebarCount}>{unplaced.length}</span>
              </button>
            </li>
          )}
        </ul>
      </div>

      {showTray ? (
        <UnplacedTray
          tables={unplaced}
          publish={scope === "tables"}
          editingLayout={canPlace}
          inErd={scope === "erd" && currentDiagramId !== undefined}
          nameDisplay={nameDisplay}
          activeTableId={activeTableId}
          onSelect={onSelect}
        />
      ) : (
        <div className={styles.sidebarSection}>
          <div className={styles.sidebarHeading}>
            {t("panel.pageTables")}
            <span className={styles.sidebarCount}>{pageTables.length}</span>
          </div>
          <ul className={styles.lpList}>
            {pageTables.map((it) => (
              <RevealLi
                key={it.id}
                active={it.id === activeTableId}
                className={cx(styles.lpItem, it.id === activeTableId && styles.active)}
                data-testid="lp-item"
                data-active={it.id === activeTableId ? "true" : undefined}
                data-color={colorAttr(it.color)}
              >
                <button type="button" className={styles.lpItemBtn} onClick={() => onSelect(it.id)}>
                  <span className={styles.lpItemName}>
                    {formatName(resolveIndexTableName(it), it.name, nameDisplay)}
                  </span>
                </button>
                <TableEditLink tableId={it.id} />
              </RevealLi>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * ページ管理ダイアログ（PageManageDialog）を開くボタン（「ページ」見出しの横）。
 * ダイアログ自体は App が出す（左パネルは2つ同時にマウントされるため、ここで出すと二重になる）。
 * ER図の編集セッションとは相互排他で、ER編集中は押せない。
 */
function PageManageButton({ open, lockedByErd }: { open: boolean; lockedByErd: boolean }) {
  const { t } = useI18n();
  const setPageInfoEditing = useAppStore((s) => s.setPageInfoEditing);
  return (
    <button
      type="button"
      className={cx("sidebar-icon-button", styles.pageInfoToggle)}
      data-testid="page-info-toggle"
      // 開いている間は見出しからもそれが読める（ダイアログの裏に隠れるが、閉じ際の目印になる）
      data-editing={open ? "true" : "false"}
      disabled={lockedByErd}
      title={lockedByErd ? t("page.infoEditLocked") : t("page.manageTitle")}
      aria-label={t("page.manageTitle")}
      onClick={() => setPageInfoEditing(true)}
    >
      <PenIcon size={13} strokeWidth={2} />
    </button>
  );
}

// ---------------------------------------------- K-12: 未配置トレイ / I-04: 配置（Sidebar から移設）

function UnplacedTray({
  tables,
  publish,
  editingLayout,
  inErd,
  nameDisplay,
  activeTableId,
  onSelect,
}: {
  tables: IndexTable[];
  /** ドキュメントモードの範囲としてこの一覧を公開するか（テーブル画面用のインスタンス） */
  publish: boolean;
  /** ER図の配置編集中か（トレイからの配置はこのセッションの操作。ページ情報編集とは別） */
  editingLayout: boolean;
  inErd: boolean;
  nameDisplay: NameDisplay;
  activeTableId?: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const recent = useAppStore((s) => s.recentTables);
  const placeTables = useCanvasStore((s) => s.placeTables);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // 今回の逆生成で追加されたものを先頭に寄せ、NEW バッジを付ける（K-12 §7.2）
  const ordered = useMemo(() => {
    const isNew = (it: IndexTable): boolean => recent.includes(it.id);
    return [...tables].sort((a, b) => Number(isNew(b)) - Number(isNew(a)));
  }, [tables, recent]);
  const orderedIds = useMemo(() => ordered.map((it) => it.id), [ordered]);
  usePublishPanelList(publish, orderedIds, t("doc.range.unplaced"));

  const canPlace = editingLayout && inErd && placeTables !== null;
  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const place = (ids: string[]): void => {
    placeTables?.(ids);
    setSelected(new Set());
  };

  return (
    <div className={styles.sidebarSection} data-testid="unplaced-tray">
      <div className={styles.sidebarHeading}>
        {t("tray.title")}
        <span className={styles.sidebarCount}>{tables.length}</span>
      </div>
      {canPlace && (
        <div className={styles.trayActions}>
          <p className="form-hint">{t("tray.hint")}</p>
          <button type="button" data-testid="tray-auto-place" onClick={() => place(ordered.map((it) => it.id))}>
            {t("tray.autoPlace")}
          </button>
          {selected.size > 0 && (
            <button
              type="button"
              className="header-button-primary"
              data-testid="tray-add-selected"
              onClick={() => place([...selected])}
            >
              {t("tray.addSelected", { n: selected.size })}
            </button>
          )}
        </div>
      )}
      <ul className={styles.lpList}>
        {ordered.map((it) => (
          <RevealLi
            key={it.id}
            active={it.id === activeTableId}
            className={cx(styles.trayRow, styles.lpItem, it.id === activeTableId && styles.active)}
            data-testid="lp-item"
            data-active={it.id === activeTableId ? "true" : undefined}
            data-color={colorAttr(it.color)}
          >
            {canPlace && (
              <input
                type="checkbox"
                aria-label={it.name}
                checked={selected.has(it.id)}
                onChange={() => toggle(it.id)}
              />
            )}
            <button
              type="button"
              // トレイ → キャンバスへのドラッグ（I-04）。ドロップ位置に 8px スナップで配置する。
              // 行全体を1つのボタンにして、ラベル以外を押しても選択が反応するようにする
              draggable={canPlace}
              onDragStart={(e) => {
                const ids = selected.has(it.id) ? [...selected] : [it.id];
                e.dataTransfer.setData(TABLE_DND_TYPE, ids.join(","));
                e.dataTransfer.effectAllowed = "copy";
              }}
              className={cx(styles.trayItem, styles.lpItemBtn, canPlace && styles.trayItemDraggable)}
              data-testid="tray-item"
              onClick={() => onSelect(it.id)}
            >
              <span className={styles.lpItemName}>
                {formatName(resolveIndexTableName(it), it.name, nameDisplay)}
              </span>
              {it.kind !== undefined && <span className={styles.lpItemKind}>{it.kind}</span>}
              {recent.includes(it.id) && <span className={styles.trayNew}>{t("tray.new")}</span>}
            </button>
            <TableEditLink tableId={it.id} />
          </RevealLi>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ 「全て」レーン

function AllLane({
  scope,
  currentDiagramId,
  activeTableId,
}: {
  scope: PanelScope;
  currentDiagramId?: string;
  activeTableId?: string;
}) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const serverMode = useAppStore((s) => s.serverMode === true);
  const editing = useEditStore((s) => s.session === "editing");
  const placeTables = useCanvasStore((s) => s.placeTables);
  const placement = usePlacement();
  const { select: onSelect, pickerNode } = useListTableSelect(scope);
  const [filter, setFilter] = useSessionState<string>(filterKey(scope), "");

  const canPlace =
    scope === "erd" && editing && serverMode && currentDiagramId !== undefined && placeTables !== null;

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = [...(index?.tables ?? [])].sort((a, b) => a.name.localeCompare(b.name, "ja"));
    if (q === "") return all;
    return all.filter((it) => {
      const resolved = resolveIndexTableName(it);
      return (
        it.name.toLowerCase().includes(q) ||
        it.id.toLowerCase().includes(q) ||
        resolved.name.toLowerCase().includes(q) ||
        // 種別でも絞り込めるようにする（O-10）。"view" と打てばビューだけが残る
        (it.kind?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [index, filter]);
  const rowIds = useMemo(() => rows.map((it) => it.id), [rows]);
  const trimmed = filter.trim();
  usePublishPanelList(
    scope === "tables",
    rowIds,
    trimmed === "" ? t("doc.range.all") : t("doc.range.allFiltered", { q: trimmed }),
  );

  return (
    <div className={styles.lpLane}>
      <div className={styles.lpLaneHead}>
        <input
          // レーン切替でこのコンポーネントが再マウントされるため、autoFocus で毎回入力へ移る
          autoFocus
          type="search"
          className={styles.lpFilter} data-testid="lp-filter"
          placeholder={t("panel.allFilter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className={styles.lpCount}>{t("catalog.count", { n: rows.length })}</span>
      </div>
      <ul className={styles.lpList}>
        {rows.map((it) => (
          <TableRow
            key={it.id}
            it={it}
            active={it.id === activeTableId}
            nameDisplay={nameDisplay}
            onPage={
              currentDiagramId !== undefined &&
              (placement.get(it.id) ?? []).includes(currentDiagramId)
            }
            canPlace={canPlace}
            onSelect={onSelect}
            onPlace={placeTables}
          />
        ))}
      </ul>
      {pickerNode}
    </div>
  );
}

// ------------------------------------------------------------------ 「検索」レーン

const MODES: MatchMode[] = ["partial", "prefix", "suffix", "exact"];

/** 保持された一致条件を採用してよいか（知らない値なら既定の「部分一致」に戻す） */
function isMatchMode(value: string): boolean {
  return (MODES as string[]).includes(value);
}

function SearchLane({
  scope,
  activeTableId,
}: {
  scope: PanelScope;
  activeTableId?: string;
}) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const tables = useAppStore((s) => s.tables);
  const dictionary = useAppStore((s) => s.dictionary);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const { select: onSelect, pickerNode } = useListTableSelect(scope);
  const [query, setQuery] = useSessionState<string>(queryKey(scope), "");
  const [mode, setMode] = useSessionState<MatchMode>(modeKey(scope), "partial", isMatchMode);

  const hits = useMemo(
    () => (index ? searchAll(query, index, tables, dictionary, 100, mode) : []),
    [query, index, tables, dictionary, mode],
  );
  const hitIds = useMemo(() => hits.map((h) => h.tableId), [hits]);
  usePublishPanelList(scope === "tables", hitIds, t("doc.range.search", { q: query.trim() }));

  return (
    <div className={styles.lpLane}>
      <div className={styles.lpLaneHead}>
        <input
          // レーン切替でこのコンポーネントが再マウントされるため、autoFocus で毎回入力へ移る
          autoFocus
          type="search"
          className={styles.lpFilter} data-testid="lp-filter"
          placeholder={t("search.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className={styles.lpMode}
          data-testid="lp-match-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as MatchMode)}
          title={t("panel.lane.search")}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {t(`columnsPage.match.${m}` as const)}
            </option>
          ))}
        </select>
      </div>
      {query.trim() === "" ? (
        <p className={styles.lpHint}>{t("search.hint")}</p>
      ) : hits.length === 0 ? (
        <p className={styles.lpHint}>{t("search.empty")}</p>
      ) : (
        <ul className={styles.lpList}>
          {hits.map((hit) => {
            const it = index?.tables?.find((x) => x.id === hit.tableId);
            if (!it) return null;
            const label = formatName(resolveIndexTableName(it), it.name, nameDisplay);
            return (
              <RevealLi
                key={hit.tableId}
                active={hit.tableId === activeTableId}
                // カラム一致はテーブル名の**下**に積む（既定の .lp-item は横並びで、
                // 一致一覧と左右に分け合うとテーブル名が1文字ずつに潰れてしまう）
                className={cx(
                  styles.lpItem,
                  styles.lpItemStacked,
                  hit.tableId === activeTableId && styles.active,
                )}
                data-testid="lp-item"
                data-active={hit.tableId === activeTableId ? "true" : undefined}
                data-color={colorAttr(it.color)}
              >
                <button type="button" className={styles.lpItemBtn} onClick={() => onSelect(hit.tableId)}>
                  <span className={styles.lpItemName}>{label}</span>
                  {hit.columnHits.length > 0 && <span className={styles.lpHitcount}>{hit.columnHits.length}</span>}
                </button>
                <TableEditLink tableId={hit.tableId} />
                {hit.columnHits.length > 0 && (
                  <ul className={styles.lpColhits}>
                    {hit.columnHits.slice(0, 6).map((c) => (
                      // 長いカラム名はパネルの幅に収まらない。1件1行のまま端を省略し、
                      // 全体は title で読ませる（折り返すと1件が何行にもなり件数を見失う）
                      <li
                        key={c.column}
                        className="mono"
                        title={c.matched === c.column ? c.column : `${c.column} · ${c.matched}`}
                      >
                        {c.column}
                        {c.matched !== c.column && <span className="muted"> · {c.matched}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </RevealLi>
            );
          })}
        </ul>
      )}
      {pickerNode}
    </div>
  );
}

// ------------------------------------------------------------------------- 共通の行（全て / 配置）

function TableRow({
  it,
  active,
  nameDisplay,
  onPage,
  canPlace,
  onSelect,
  onPlace,
}: {
  it: IndexTable;
  active: boolean;
  nameDisplay: NameDisplay;
  /** 現在のページに配置済みか（保存前の追加・除去も反映した判定） */
  onPage: boolean;
  canPlace: boolean;
  onSelect: (id: string) => void;
  onPlace: ((ids: string[], at?: [number, number]) => void) | null;
}) {
  const { t } = useI18n();
  const draggable = canPlace && !onPage;
  const label = formatName(resolveIndexTableName(it), it.name, nameDisplay);
  return (
    <RevealLi
      active={active}
      className={cx(styles.lpItem, styles.sidebarTableRow, active && styles.active)}
      data-testid="lp-item"
      data-active={active ? "true" : undefined}
      data-color={colorAttr(it.color)}
    >
      {/* 行全体を1つのボタンにする（ラベル以外を押しても反応するように）。DnD の起点も兼ねる */}
      <button
        type="button"
        className={cx(styles.lpItemBtn, styles.sidebarTableItem, draggable && styles.trayItemDraggable)} data-testid="table-item"
        draggable={draggable}
        onDragStart={
          draggable
            ? (e) => {
                e.dataTransfer.setData(TABLE_DND_TYPE, it.id);
                e.dataTransfer.effectAllowed = "copy";
              }
            : undefined
        }
        onClick={() => onSelect(it.id)}
      >
        <span className={styles.lpItemName}>{label}</span>
        {/* ビュー等の種別（O-10）。DB が返した原文なので翻訳しない */}
        {it.kind !== undefined && <span className={styles.lpItemKind}>{it.kind}</span>}
      </button>
      {/* 編集への近道と配置（＋ / ✓）は排他: 近道は編集中に出ず、＋ は編集中にしか出ない */}
      <TableEditLink tableId={it.id} />
      {canPlace &&
        (onPage ? (
          <span className={styles.sidebarOnpage} title={t("table.onThisPage")} aria-hidden="true">
            ✓
          </span>
        ) : (
          <button
            type="button"
            className={cx("sidebar-icon-button", styles.sidebarAddToPage)}
            data-testid={`add-to-page-${it.id}`}
            title={t("table.addToCurrentPage")}
            onClick={() => onPlace?.([it.id])}
          >
            ＋
          </button>
        ))}
    </RevealLi>
  );
}

// アイコン（インライン SVG。静的モードでは外部アイコンフォントを使えないため）。
// ペン（編集）はヘッダ・ページ管理と共用するので ./icons にある

function PagesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 16l9 5 9-5" />
    </svg>
  );
}
function AllIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="3.5" cy="6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </svg>
  );
}
