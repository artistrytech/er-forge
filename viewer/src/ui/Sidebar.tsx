/**
 * サイドバー（B-01〜B-05 / I-01〜I-04 / I-06 / K-12）。
 *
 * ページ一覧（order 順・テーブル数併記）と全テーブル一覧、そして未配置トレイ。
 * 各項目は実リンク（X-04）。編集中 × サーバーモードのときだけ、ページの追加 / 改名 /
 * 並び替え / 削除（I-01〜I-03）と、トレイからの配置（I-04）を出す。
 *
 * **「未配置」はフラグではなく導出**である（K-12 §7.1）。
 * 未配置テーブル = index.tables[].diagrams が空のもの。これにより、逆生成で追加された
 * テーブルも、人がページから除去したテーブルも、同じトレイに同じ理由で現れる。
 */
import { useMemo, useState } from "react";
import { TABLE_DND_TYPE } from "../canvas/ErdPage";
import { useCanvasStore } from "../canvas/canvasStore";
import { useI18n } from "../i18n/useI18n";
import { useEditStore } from "../model/editStore";
import { formatName, resolveIndexTableName } from "../model/logicalName";
import { useAppStore } from "../model/store";
import type { IndexTable } from "../model/types";
import { AddPageButton } from "./AddPage";
import { Dialog } from "./Dialog";
import { Link } from "./Link";
import { hrefs } from "./router";

export function Sidebar({ currentDiagramId }: { currentDiagramId?: string }) {
  const { t } = useI18n();
  const manifest = useAppStore((s) => s.manifest);
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const serverMode = useAppStore((s) => s.serverMode === true);
  const editing = useEditStore((s) => s.session === "editing");
  const canManage = editing && serverMode;

  const diagrams = useMemo(
    () => [...(manifest?.diagrams ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [manifest],
  );

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
  const placed = sortedTables.filter((it) => (it.diagrams ?? []).length > 0);
  const unplaced = sortedTables.filter((it) => (it.diagrams ?? []).length === 0);

  return (
    <nav className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-heading">
          {t("sidebar.pages")}
          {canManage && <AddPageButton />}
        </div>
        <ul>
          {diagrams.map((d, i) => (
            <li key={d.id} className="sidebar-page-row">
              <Link
                href={hrefs.erd(d.id)}
                className={"sidebar-link" + (d.id === currentDiagramId ? " active" : "")}
              >
                {d.title ?? d.id}
                <span className="sidebar-count">
                  {t("sidebar.tableCount", { n: tableCountByDiagram.get(d.id) ?? 0 })}
                </span>
              </Link>
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
        </ul>
      </div>

      <UnplacedTray tables={unplaced} canManage={canManage} inErd={currentDiagramId !== undefined} />

      <div className="sidebar-section">
        <div className="sidebar-heading">{t("sidebar.tables")}</div>
        <ul>
          {placed.map((it) => {
            // 現在のページにあればそのページへ、なければ最初の所属ページへ（B-04）
            const target =
              currentDiagramId !== undefined && (it.diagrams ?? []).includes(currentDiagramId)
                ? currentDiagramId
                : it.diagrams?.[0];
            const label = formatName(resolveIndexTableName(it), it.name, nameDisplay);
            return (
              <li key={it.id}>
                <Link
                  className="sidebar-link"
                  href={target !== undefined ? hrefs.erd(target, it.id) : hrefs.table(it.id)}
                >
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

// ---------------------------------------------- I-02 / I-03: 削除・改名・並び替え

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
              onClick={() =>
                void deletePage(diagramId).then((r) =>
                  r.ok ? onDeleted() : addToast(r.error),
                )
              }
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
          void onRename(diagramId, title.trim()).then((r) =>
            r.ok ? onClose() : setError(r.error ?? ""),
          );
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

// ---------------------------------------------- K-12: 未配置トレイ / I-04: 配置

function UnplacedTray({
  tables,
  canManage,
  inErd,
}: {
  tables: IndexTable[];
  canManage: boolean;
  inErd: boolean;
}) {
  const { t } = useI18n();
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const recent = useAppStore((s) => s.recentTables);
  const placeTables = useCanvasStore((s) => s.placeTables);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // 今回の逆生成で追加されたものを先頭に寄せ、NEW バッジを付ける（K-12 §7.2）
  const ordered = useMemo(() => {
    const isNew = (it: IndexTable): boolean => recent.includes(it.id);
    return [...tables].sort((a, b) => Number(isNew(b)) - Number(isNew(a)));
  }, [tables, recent]);

  if (tables.length === 0) return null;

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
          <button
            type="button"
            data-testid="tray-auto-place"
            onClick={() => place(ordered.map((it) => it.id))}
          >
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
      <ul>
        {ordered.map((it) => (
          <li key={it.id} className="tray-row">
            {canPlace && (
              <input
                type="checkbox"
                aria-label={it.name}
                checked={selected.has(it.id)}
                onChange={() => toggle(it.id)}
              />
            )}
            <span
              // トレイ → キャンバスへのドラッグ（I-04）。ドロップ位置に 8px スナップで配置する
              draggable={canPlace}
              onDragStart={(e) => {
                const ids = selected.has(it.id) ? [...selected] : [it.id];
                e.dataTransfer.setData(TABLE_DND_TYPE, ids.join(","));
                e.dataTransfer.effectAllowed = "copy";
              }}
              className={"tray-item" + (canPlace ? " tray-item-draggable" : "")}
            >
              <Link className="sidebar-link muted" href={hrefs.table(it.id)}>
                {formatName(resolveIndexTableName(it), it.name, nameDisplay)}
              </Link>
              {recent.includes(it.id) && <span className="tray-new">{t("tray.new")}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
