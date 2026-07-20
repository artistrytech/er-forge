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
 *   未配置なら詳細ダイアログ（ダブルクリック相当）。
 * - テーブル画面: 右ペインに詳細（URL にテーブルを埋め込む）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { useCanvasStore } from "../canvas/canvasStore";
import { TABLE_DND_TYPE } from "../canvas/ErdPage";
import { useEditStore } from "../model/editStore";
import { formatName, resolveIndexTableName, type NameDisplay } from "../model/logicalName";
import { searchAll, type MatchMode } from "../model/search";
import { useAppStore } from "../model/store";
import type { IndexTable } from "../model/types";
import { AddPageButton } from "./AddPage";
import { Dialog } from "./Dialog";
import { hrefs } from "./router";

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
  return (
    <div className="left-panel">
      <IconRail lane={lane} onChange={setLane} />
      <div className="lp-body">
        {lane === "pages" && (
          <PagesLane scope={scope} currentDiagramId={currentDiagramId} activeTableId={activeTableId} />
        )}
        {lane === "all" && (
          <AllLane scope={scope} currentDiagramId={currentDiagramId} activeTableId={activeTableId} />
        )}
        {lane === "search" && <SearchLane scope={scope} activeTableId={activeTableId} />}
      </div>
    </div>
  );
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
    <div className="lp-rail" role="tablist" aria-orientation="vertical">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={lane === it.id}
          className={"lp-rail-item" + (lane === it.id ? " active" : "")}
          title={it.label}
          data-testid={`lane-${it.id}`}
          onClick={() => onChange(it.id)}
        >
          {it.icon}
          <span className="lp-rail-label">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * 「ページ」レーンからのテーブル選択（従来通り）。ER図では現在のページでフォーカス、
 * 別ページにあればそのページでフォーカス、未配置は詳細ダイアログ（回答3 / 6）。
 */
function useTableSelect(scope: PanelScope, currentDiagramId?: string): (tableId: string) => void {
  const index = useAppStore((s) => s.index);
  const openDialog = useAppStore((s) => s.openDialog);
  return useCallback(
    (tableId: string) => {
      if (scope === "tables") {
        location.hash = hrefs.table(tableId);
        return;
      }
      const it = index?.tables?.find((x) => x.id === tableId);
      const diagrams = it?.diagrams ?? [];
      const otherPage = diagrams[0];
      if (currentDiagramId !== undefined && diagrams.includes(currentDiagramId)) {
        location.hash = hrefs.erd(currentDiagramId, tableId); // 現在のページでフォーカス
      } else if (otherPage !== undefined) {
        location.hash = hrefs.erd(otherPage, tableId); // 別ページでフォーカス（回答6）
      } else {
        openDialog({ type: "table", id: tableId }); // 未配置は詳細ダイアログ（回答3）
      }
    },
    [scope, currentDiagramId, index, openDialog],
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
  const index = useAppStore((s) => s.index);
  const openDialog = useAppStore((s) => s.openDialog);
  const [picker, setPicker] = useState<{ tableId: string; pages: string[] } | null>(null);

  const select = useCallback(
    (tableId: string) => {
      if (scope === "tables") {
        location.hash = hrefs.table(tableId);
        return;
      }
      const it = index?.tables?.find((x) => x.id === tableId);
      const pages = it?.diagrams ?? [];
      if (pages.length === 0) {
        openDialog({ type: "table", id: tableId }); // 未配置は詳細ダイアログ
      } else if (pages.length === 1) {
        location.hash = hrefs.erd(pages[0]!, tableId); // 1ページはそのページでフォーカス
      } else {
        setPicker({ tableId, pages }); // 複数ページはダイアログで選ばせる
      }
    },
    [scope, index, openDialog],
  );

  const pickerNode =
    picker !== null ? (
      <PagePickerDialog
        tableId={picker.tableId}
        pages={picker.pages}
        onPick={(page) => {
          location.hash = hrefs.erd(page, picker.tableId);
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
      <ul className="page-pick-list">
        {pages.map((p) => (
          <li key={p}>
            <button type="button" className="page-pick-item" onClick={() => onPick(p)}>
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
  const onSelect = useTableSelect(scope, currentDiagramId);
  // ページの追加/改名/並替/削除・配置は ER×編集×サーバーのときだけ（テーブル画面は閲覧専用）
  const canManage = scope === "erd" && editing && serverMode;

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
    for (const it of index?.tables ?? []) {
      for (const d of it.diagrams ?? []) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return counts;
  }, [index]);

  const sortedTables = useMemo(
    () => [...(index?.tables ?? [])].sort((a, b) => a.name.localeCompare(b.name, "ja")),
    [index],
  );
  const unplaced = sortedTables.filter((it) => (it.diagrams ?? []).length === 0);
  const pageTables =
    selectedPage === undefined || selectedPage === UNPLACED
      ? []
      : sortedTables.filter((it) => (it.diagrams ?? []).includes(selectedPage));

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
    // 未配置の疑似ページは見た目上のページ切り替えをしない（回答D）
    if (scope === "erd" && id !== UNPLACED) location.hash = hrefs.erd(id);
  };

  return (
    <div className="lp-lane">
      <div className="sidebar-section">
        <div className="sidebar-heading">
          {t("sidebar.pages")}
          {canManage && <AddPageButton />}
        </div>
        <ul>
          {diagrams.map((d, i) => (
            <li key={d.id} className="sidebar-page-row lp-page-item">
              <button
                type="button"
                className={"lp-page-row" + (d.id === selectedPage ? " active" : "")}
                onClick={() => selectPage(d.id)}
              >
                <span className="lp-item-name">{d.title ?? d.id}</span>
                <span className="sidebar-count">
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
            <li className="lp-page-item">
              <button
                type="button"
                data-testid="unplaced-page"
                className={"lp-page-row" + (selectedPage === UNPLACED ? " active" : "")}
                onClick={() => selectPage(UNPLACED)}
              >
                <span className="lp-item-name muted">{t("sidebar.unplaced")}</span>
                <span className="sidebar-count">{unplaced.length}</span>
              </button>
            </li>
          )}
        </ul>
      </div>

      {showTray ? (
        <UnplacedTray
          tables={unplaced}
          canManage={canManage}
          inErd={scope === "erd" && currentDiagramId !== undefined}
          nameDisplay={nameDisplay}
          activeTableId={activeTableId}
          onSelect={onSelect}
        />
      ) : (
        <div className="sidebar-section">
          <div className="sidebar-heading">
            {t("panel.pageTables")}
            <span className="sidebar-count">{pageTables.length}</span>
          </div>
          <ul className="lp-list">
            {pageTables.map((it) => (
              <li key={it.id} className={"lp-item" + (it.id === activeTableId ? " active" : "")}>
                <button type="button" className="lp-item-btn" onClick={() => onSelect(it.id)}>
                  <span className="lp-item-name">
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
    // 削除したページを開いていたら、ページ一覧の先頭へ戻す（白画面にしない。B-11）
    const first = useAppStore.getState().manifest?.diagrams?.[0]?.id;
    location.hash = first !== undefined ? hrefs.erd(first) : hrefs.tables();
  };

  return (
    <span className="sidebar-page-controls">
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
  canManage,
  inErd,
  nameDisplay,
  activeTableId,
  onSelect,
}: {
  tables: IndexTable[];
  canManage: boolean;
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

  const canPlace = canManage && inErd && placeTables !== null;
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
    <div className="sidebar-section" data-testid="unplaced-tray">
      <div className="sidebar-heading">
        {t("tray.title")}
        <span className="sidebar-count">{tables.length}</span>
      </div>
      {canPlace && (
        <div className="tray-actions">
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
      <ul className="lp-list">
        {ordered.map((it) => (
          <li key={it.id} className={"tray-row lp-item" + (it.id === activeTableId ? " active" : "")}>
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
              className={"tray-item lp-item-btn" + (canPlace ? " tray-item-draggable" : "")}
              onClick={() => onSelect(it.id)}
            >
              <span className="lp-item-name">
                {formatName(resolveIndexTableName(it), it.name, nameDisplay)}
              </span>
              {recent.includes(it.id) && <span className="tray-new">{t("tray.new")}</span>}
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
    <div className="lp-lane">
      <div className="lp-lane-head">
        <input
          type="search"
          className="lp-filter"
          placeholder={t("panel.allFilter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="lp-count">{t("catalog.count", { n: rows.length })}</span>
      </div>
      <ul className="lp-list">
        {rows.map((it) => (
          <TableRow
            key={it.id}
            it={it}
            active={it.id === activeTableId}
            nameDisplay={nameDisplay}
            currentDiagramId={currentDiagramId}
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
    <div className="lp-lane">
      <div className="lp-lane-head lp-search-head">
        <input
          type="search"
          className="lp-filter"
          placeholder={t("search.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="lp-mode"
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
        <p className="lp-hint">{t("search.hint")}</p>
      ) : hits.length === 0 ? (
        <p className="lp-hint">{t("search.empty")}</p>
      ) : (
        <ul className="lp-list">
          {hits.map((hit) => {
            const it = index?.tables?.find((x) => x.id === hit.tableId);
            if (!it) return null;
            const label = formatName(resolveIndexTableName(it), it.name, nameDisplay);
            return (
              <li key={hit.tableId} className={"lp-item" + (hit.tableId === activeTableId ? " active" : "")}>
                <button type="button" className="lp-item-btn" onClick={() => onSelect(hit.tableId)}>
                  <span className="lp-item-name">{label}</span>
                  {hit.columnHits.length > 0 && <span className="lp-hitcount">{hit.columnHits.length}</span>}
                </button>
                {hit.columnHits.length > 0 && (
                  <ul className="lp-colhits">
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
  currentDiagramId,
  canPlace,
  onSelect,
  onPlace,
}: {
  it: IndexTable;
  active: boolean;
  nameDisplay: NameDisplay;
  currentDiagramId?: string;
  canPlace: boolean;
  onSelect: (id: string) => void;
  onPlace: ((ids: string[], at?: [number, number]) => void) | null;
}) {
  const { t } = useI18n();
  const onPage = currentDiagramId !== undefined && (it.diagrams ?? []).includes(currentDiagramId);
  const draggable = canPlace && !onPage;
  const label = formatName(resolveIndexTableName(it), it.name, nameDisplay);
  return (
    <li className={"lp-item sidebar-table-row" + (active ? " active" : "")}>
      {/* 行全体を1つのボタンにする（ラベル以外を押しても反応するように）。DnD の起点も兼ねる */}
      <button
        type="button"
        className={"lp-item-btn sidebar-table-item" + (draggable ? " tray-item-draggable" : "")}
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
        <span className="lp-item-name">{label}</span>
      </button>
      {canPlace &&
        (onPage ? (
          <span className="sidebar-onpage" title={t("table.onThisPage")} aria-hidden="true">
            ✓
          </span>
        ) : (
          <button
            type="button"
            className="sidebar-icon-button sidebar-add-to-page"
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
