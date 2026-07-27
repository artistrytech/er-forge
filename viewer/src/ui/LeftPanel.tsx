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
 * 状態が保持される（回答2）。
 *
 * テーブルを選択したときの遷移（回答3 / 6）:
 * - ER画面: 現在のページにあればフォーカス、別ページにあればそのページでフォーカス、
 *   未配置なら詳細ダイアログ（ダブルクリック相当）。**編集中は編集ルートのままフォーカスする**。
 * - テーブル画面: 右ペインに詳細（URL にテーブルを埋め込む）。
 *
 * 編集の導線は2つあり、どちらか一方しか有効にならない:
 * - ER図の配置編集（editStore のセッション。保存が要る）… 未配置トレイからの配置・ドラッグ
 * - ページ情報の編集（「ページ」見出しの ✎。**即時にファイルへ書かれる**）… 追加・改名・並替・削除
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { useCanvasStore } from "../canvas/canvasStore";
import { TABLE_DND_TYPE } from "../canvas/ErdPage";
import { colorAttr } from "../model/colors";
import { useEditStore } from "../model/editStore";
import { formatName, resolveIndexTableName, type NameDisplay } from "../model/logicalName";
import { searchAll, type MatchMode } from "../model/search";
import { useAppStore } from "../model/store";
import type { IndexTable } from "../model/types";
import { AddPageButton } from "./AddPage";
import { Dialog } from "./Dialog";
import { hrefs } from "./router";
import { cx } from "../lib/cx";
import styles from "./LeftPanel.module.scss";

export type PanelScope = "erd" | "tables";
type Lane = "pages" | "all" | "search";

/** 未配置の疑似ページを表す選択センチネル（回答3） */
const UNPLACED = "__unplaced__";

interface LeftPanelProps {
  scope: PanelScope;
  /** ER画面: 現在のページ */
  currentDiagramId?: string;
  /** ER画面: フォーカス中テーブル / テーブル画面: 選択中テーブル */
  activeTableId?: string;
}

export function LeftPanel({ scope, currentDiagramId, activeTableId }: LeftPanelProps) {
  const [lane, setLane] = useState<Lane>("pages");
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
  return useCallback(
    (tableId: string) => {
      if (scope === "tables") {
        location.hash = hrefs.table(tableId);
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
    [scope, currentDiagramId, placement, erdHref, openDialog],
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
  const [picker, setPicker] = useState<{ tableId: string; pages: string[] } | null>(null);

  const select = useCallback(
    (tableId: string) => {
      if (scope === "tables") {
        location.hash = hrefs.table(tableId);
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
    [scope, placement, erdHref, openDialog],
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
  const manifest = useAppStore((s) => s.manifest);
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const serverMode = useAppStore((s) => s.serverMode === true);
  const editing = useEditStore((s) => s.session === "editing");
  const pageInfoEditing = useAppStore((s) => s.pageInfoEditing);
  const placement = usePlacement();
  const onSelect = useTableSelect(scope, currentDiagramId);
  const erdHref = useErdHref();
  /*
   * ページ情報（追加・改名・並び替え・削除）は**即時にファイルへ書かれる**ため、ER図の配置編集
   * （保存が要る）とは導線を分ける。ここは「ページ」見出しの ✎ で入る専用モードで、ER編集中は
   * 入れない（逆にこのモード中は ER・テーブルの編集を始められない。Header 側で止めている）。
   * テーブル画面の左パネルからも同じように扱える。
   */
  const canManage = serverMode && pageInfoEditing && !editing;
  // 未配置トレイからの配置は ER図の編集セッション側の操作（ページ情報編集とは別物）
  const canPlace = scope === "erd" && editing && serverMode;

  const diagrams = useMemo(
    () => [...(manifest?.diagrams ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [manifest],
  );

  // 選択中ページ。ER はルート（現在のページ）に追従、テーブルはローカル選択
  const [selectedPage, setSelectedPage] = useState<string | undefined>(
    currentDiagramId ?? diagrams[0]?.id,
  );
  useEffect(() => {
    if (scope === "erd") {
      if (currentDiagramId !== undefined) setSelectedPage(currentDiagramId);
    } else {
      setSelectedPage((prev) => prev ?? diagrams[0]?.id);
    }
  }, [scope, currentDiagramId, diagrams]);

  const tableCountByDiagram = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pages of placement.values()) {
      for (const d of pages) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return counts;
  }, [placement]);

  const sortedTables = useMemo(
    () => [...(index?.tables ?? [])].sort((a, b) => a.name.localeCompare(b.name, "ja")),
    [index],
  );
  const unplaced = sortedTables.filter((it) => (placement.get(it.id) ?? []).length === 0);
  const pageTables =
    selectedPage === undefined || selectedPage === UNPLACED
      ? []
      : sortedTables.filter((it) => (placement.get(it.id) ?? []).includes(selectedPage));

  // 未配置の疑似ページを選択中に未配置が尽きたら、実ページの表示へ戻す
  // （配置し終えたら未配置トレイは消える。K-12 §7.1）
  const showTray = selectedPage === UNPLACED && unplaced.length > 0;
  useEffect(() => {
    if (selectedPage === UNPLACED && unplaced.length === 0) {
      setSelectedPage(scope === "erd" ? (currentDiagramId ?? diagrams[0]?.id) : diagrams[0]?.id);
    }
  }, [selectedPage, unplaced.length, scope, currentDiagramId, diagrams]);

  const selectPage = (id: string): void => {
    setSelectedPage(id);
    // ER図では実ページの選択でそのページへ遷移（現在のページを切り替える）。
    // 編集中は編集ルートのまま切り替える（ページを選ぶだけで編集が終わらないように）。
    // 未配置の疑似ページは見た目上のページ切り替えをしない（回答D）
    if (scope === "erd" && id !== UNPLACED) location.hash = erdHref(id);
  };

  return (
    <div className={styles.lpLane}>
      <div className={styles.sidebarSection}>
        <div className={styles.sidebarHeading}>
          {t("sidebar.pages")}
          {serverMode && (
            <span className={styles.pageHeadActions}>
              {canManage && <AddPageButton />}
              <PageInfoEditToggle editing={canManage} lockedByErd={editing} />
            </span>
          )}
        </div>
        <ul>
          {diagrams.map((d, i) => (
            <li key={d.id} className={styles.sidebarPageRow} data-testid="page-row">
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
              {canManage && (
                <PageControls
                  diagramId={d.id}
                  title={d.title ?? d.id}
                  first={i === 0}
                  last={i === diagrams.length - 1}
                />
              )}
            </li>
          ))}
          {unplaced.length > 0 && (
            <li>
              <button
                type="button"
                data-testid="unplaced-page"
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
              <li
                key={it.id}
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
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * ページ情報の編集モードの開始・終了（「ページ」見出しの横）。
 * ER図の編集セッションとは相互排他で、ER編集中は押せない。
 */
function PageInfoEditToggle({ editing, lockedByErd }: { editing: boolean; lockedByErd: boolean }) {
  const { t } = useI18n();
  const setPageInfoEditing = useAppStore((s) => s.setPageInfoEditing);
  return (
    <button
      type="button"
      className={cx("sidebar-icon-button", styles.pageInfoToggle)}
      data-testid="page-info-toggle"
      data-editing={editing ? "true" : "false"}
      disabled={lockedByErd}
      title={
        lockedByErd
          ? t("page.infoEditLocked")
          : editing
            ? t("page.infoEditEnd")
            : t("page.infoEditStart")
      }
      onClick={() => setPageInfoEditing(!editing)}
    >
      {editing ? "✕" : "✎"}
    </button>
  );
}

// ---------------------------------------------- I-02 / I-03: 削除・改名・並び替え（Sidebar から移設）

function PageControls({
  diagramId,
  title,
  first,
  last,
}: {
  diagramId: string;
  title: string;
  first: boolean;
  last: boolean;
}) {
  const { t } = useI18n();
  const renamePage = useEditStore((s) => s.renamePage);
  const reorderPage = useEditStore((s) => s.reorderPage);
  const deletePage = useEditStore((s) => s.deletePage);
  const addToast = useAppStore((s) => s.addToast);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const onDeleted = (): void => {
    setConfirming(false);
    addToast(t("page.deleted", { title }));
    // 削除したページを**開いていたときだけ**先頭ページへ戻す（白画面にしない。B-11）。
    // テーブル画面や別ページから消した場合は、今いる画面に留まる
    if (useAppStore.getState().currentDiagramId !== diagramId) return;
    const first = useAppStore.getState().manifest?.diagrams?.[0]?.id;
    location.hash = first !== undefined ? hrefs.erd(first) : hrefs.tables();
  };

  return (
    <span className={styles.sidebarPageControls}>
      <button
        type="button"
        className="sidebar-icon-button"
        title={t("page.moveUp")}
        disabled={first}
        onClick={() => void reorderPage(diagramId, "up")}
      >
        ↑
      </button>
      <button
        type="button"
        className="sidebar-icon-button"
        title={t("page.moveDown")}
        disabled={last}
        onClick={() => void reorderPage(diagramId, "down")}
      >
        ↓
      </button>
      <button
        type="button"
        className="sidebar-icon-button"
        data-testid={`page-rename-${diagramId}`}
        title={t("page.rename")}
        onClick={() => setRenaming(true)}
      >
        ✎
      </button>
      <button
        type="button"
        className="sidebar-icon-button"
        data-testid={`page-delete-${diagramId}`}
        title={t("page.delete")}
        onClick={() => setConfirming(true)}
      >
        🗑
      </button>
      {renaming && (
        <RenamePageDialog
          diagramId={diagramId}
          current={title}
          onRename={renamePage}
          onClose={() => setRenaming(false)}
        />
      )}
      {confirming && (
        <Dialog title={t("page.deleteTitle")} onClose={() => setConfirming(false)}>
          <p>{t("page.deleteBody", { title })}</p>
          <div className="dialog-actions">
            <button
              type="button"
              className="header-button-primary"
              data-testid="page-delete-confirm"
              onClick={() => void deletePage(diagramId).then((r) => (r.ok ? onDeleted() : addToast(r.error)))}
            >
              {t("page.deleteConfirm")}
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              {t("layout.cancel")}
            </button>
          </div>
        </Dialog>
      )}
    </span>
  );
}

function RenamePageDialog({
  diagramId,
  current,
  onRename,
  onClose,
}: {
  diagramId: string;
  current: string;
  onRename: (id: string, title: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(current);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog title={t("page.renameTitle")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onRename(diagramId, title.trim()).then((r) => (r.ok ? onClose() : setError(r.error ?? "")));
        }}
      >
        <label className="form-row">
          <span>{t("page.title")}</span>
          <input
            autoFocus
            data-testid="page-rename-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        {error !== null && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button
            type="submit"
            className="header-button-primary"
            data-testid="page-rename-save"
            disabled={title.trim() === ""}
          >
            {t("page.rename")}
          </button>
          <button type="button" onClick={onClose}>
            {t("layout.cancel")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------- K-12: 未配置トレイ / I-04: 配置（Sidebar から移設）

function UnplacedTray({
  tables,
  editingLayout,
  inErd,
  nameDisplay,
  activeTableId,
  onSelect,
}: {
  tables: IndexTable[];
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
          <li
            key={it.id}
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
              {recent.includes(it.id) && <span className={styles.trayNew}>{t("tray.new")}</span>}
            </button>
          </li>
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
  const [filter, setFilter] = useState("");

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
        resolved.name.toLowerCase().includes(q)
      );
    });
  }, [index, filter]);

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
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<MatchMode>("partial");

  const hits = useMemo(
    () => (index ? searchAll(query, index, tables, dictionary, 100, mode) : []),
    [query, index, tables, dictionary, mode],
  );

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
              <li
                key={hit.tableId}
                className={cx(styles.lpItem, hit.tableId === activeTableId && styles.active)}
                data-testid="lp-item"
                data-active={hit.tableId === activeTableId ? "true" : undefined}
                data-color={colorAttr(it.color)}
              >
                <button type="button" className={styles.lpItemBtn} onClick={() => onSelect(hit.tableId)}>
                  <span className={styles.lpItemName}>{label}</span>
                  {hit.columnHits.length > 0 && <span className={styles.lpHitcount}>{hit.columnHits.length}</span>}
                </button>
                {hit.columnHits.length > 0 && (
                  <ul className={styles.lpColhits}>
                    {hit.columnHits.slice(0, 6).map((c) => (
                      <li key={c.column} className="mono">
                        {c.column}
                        {c.matched !== c.column && <span className="muted"> · {c.matched}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
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
    <li
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
      </button>
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
    </li>
  );
}

// アイコン（インライン SVG。静的モードでは外部アイコンフォントを使えないため）
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
