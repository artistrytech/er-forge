/**
 * カラム辞書の画面（P-03）。同名カラムに効く共通設定（論理名・タグ・色）を1箇所で編める。
 *
 * 閲覧ルート `#/columns` と編集ルート `#/columns/edit` を分ける（§2.4）。
 * 閲覧ルートでは辞書を読み取り表示し、[編集開始] で編集ルートへ遷移して初めて編集できる。
 * 静的モードでは閲覧のみ（[編集開始] を出さない）。編集ロックは無い（H-11 廃止）。
 * 全体を1回の PUT で置換し、保存後は閲覧モード（#/columns）へ戻る。
 * 全テーブルのロード完了までは編集は可能だが保存は待たせる（§2.5）。
 *
 * 論理名・タグ・色はすべて**行内で編集する**（数百行を上から順に埋める作業がこの画面の
 * 主目的で、1件ずつダイアログを開かせると仕事にならない）。そのため一覧は**仮想化**し、
 * 見えている行だけを描く（lib/virtualRows.ts）。**行の高さは固定**で、タグは折り返さない。
 * [🔍] のダイアログは出現テーブル・個別設定の内訳を見るためのもの。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { apiGet, apiPut, wpath } from "../model/api";
import {
  aggregateColumns,
  applyPastedRow,
  draftsOf,
  EMPTY_DRAFT,
  isEmptyDraft,
  parseTsvRows,
  type DictionaryDraft,
} from "../model/columnDictionary";
import { colorAttr } from "../model/colors";
import { rememberOwnRevision } from "../model/editStore";
import { usePageEditStore } from "../model/pageEditStore";
import { reloadDictionary } from "../model/loader";
import { matchText, type MatchMode } from "../model/search";
import { totalTableCount, useAppStore } from "../model/store";
import { cx } from "../lib/cx";
import { renderPlan, ROW_HEIGHT, useVisibleRange } from "../lib/virtualRows";
import { ColorSelect } from "../ui/ColorSelect";
import { Dialog } from "../ui/Dialog";
import { ScrollTable } from "../ui/ScrollTable";
import { TagInput } from "../ui/TagInput";
import { hrefs, type ColumnMatch } from "../ui/router";
import { ColumnDetailDialog } from "./ColumnDetailDialog";
import styles from "./ColumnsPage.module.scss";

type Filter = "all" | "unset" | "overridden" | "orphan";

const MATCH_MODES: MatchMode[] = ["partial", "prefix", "suffix", "exact"];

export function ColumnsPage({
  editing,
  focusColumn,
  focusMatch,
}: {
  editing: boolean;
  /** 検索モーダルからの遷移時に絞り込む物理カラム名（回答A） */
  focusColumn?: string;
  focusMatch?: ColumnMatch;
}) {
  const { t } = useI18n();
  const tables = useAppStore((s) => s.tables);
  const dictionary = useAppStore((s) => s.dictionary);
  const index = useAppStore((s) => s.index);
  const loaded = useAppStore((s) => s.loadedTableCount);
  const failed = useAppStore((s) => s.failedTableCount);
  const total = useAppStore((s) => totalTableCount(s));
  const addToast = useAppStore((s) => s.addToast);
  const serverMode = useAppStore((s) => s.serverMode === true);
  // 編集ルートにいる時点で編集モード（App は静的モードだと閲覧へリダイレクトする）
  const canEdit = editing && serverMode;

  const allLoaded = loaded + failed >= total;

  const [draft, setDraft] = useState<Record<string, DictionaryDraft>>({});
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState(focusColumn ?? "");
  const [matchMode, setMatchMode] = useState<MatchMode>(focusMatch ?? "partial");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [detail, setDetail] = useState<string | null>(null);
  /** 入力中の行。仮想化で unmount させないよう、範囲外でも描き続ける */
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 辞書の初期値と baseHash。辞書が外部変更されたら未編集キーのみ追随する
  useEffect(() => {
    setDraft((prev) => {
      const next = draftsOf(dictionary);
      for (const key of dirtyKeys) {
        if (prev[key] !== undefined) next[key] = prev[key];
        else delete next[key];
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictionary]);
  useEffect(() => {
    // baseHash は保存にのみ使う。閲覧モード / 静的モードでは取りに行かない
    if (!canEdit) return;
    apiGet(wpath("/dictionary")).then(
      (res) => {
        if (res.status === 200) {
          setBaseHash((JSON.parse(res.body) as { baseHash: string }).baseHash);
        }
      },
      () => undefined,
    );
  }, [canEdit]);

  // 検索モーダルからの遷移（focusColumn / focusMatch）で絞り込みを張り替える（回答A）。
  // マウント継続中に別のカラムへ遷移した場合にも追随する
  useEffect(() => {
    if (focusColumn !== undefined) {
      setSearch(focusColumn);
      setMatchMode(focusMatch ?? "exact");
    }
  }, [focusColumn, focusMatch]);

  const rows = useMemo(
    () => aggregateColumns(Object.values(tables), dictionary),
    [tables, dictionary],
  );

  const visible = useMemo(() => {
    const q = search.trim();
    return rows.filter((r) => {
      const value = draft[r.name] ?? EMPTY_DRAFT;
      if (filter === "unset" && value.displayName !== "") return false;
      if (filter === "overridden" && r.overrides.length === 0) return false;
      if (filter === "orphan" && r.occurrences > 0) return false;
      if (q !== "") {
        const hit =
          matchText(r.name, q, matchMode) ||
          matchText(value.displayName, q, matchMode) ||
          value.tags.some((tag) => matchText(tag, q, matchMode));
        if (!hit) return false;
      }
      return true;
    });
  }, [rows, draft, filter, search, matchMode]);

  // 絞り込みが変わると行が入れ替わる。前の位置に留まると「行が無い場所」を見ることになる
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filter, search, matchMode]);

  const range = useVisibleRange(scrollRef, visible.length);
  const plan = useMemo(() => {
    const pinned = activeRow === null ? -1 : visible.findIndex((r) => r.name === activeRow);
    return renderPlan(range, visible.length, pinned < 0 ? undefined : pinned);
  }, [range, visible, activeRow]);

  // タグ候補（P-12）: index.js の使用中タグ（テーブル・カラム個別のもの）＋ 辞書の共通タグ。
  // 辞書のタグは index.js に載せない（載せると辞書保存のたびに index 再生成が要る。P §4.3）
  const tagCandidates = useMemo(() => {
    const all = new Set(index?.tagsUsed ?? []);
    for (const d of Object.values(draft)) {
      for (const tag of d.tags) all.add(tag);
    }
    return [...all].sort((a, b) => a.localeCompare(b, "ja"));
  }, [index, draft]);

  const dirty = dirtyKeys.size > 0;

  // 保存・編集終了はヘッダ（EditControls）から行う。編集ルート滞在中だけコントローラを登録する。
  // 未保存があってもリロード・他ページ遷移は妨げない（確認は終了操作に限定）。
  const setController = usePageEditStore((s) => s.setController);
  const saveRef = useRef<(force: boolean) => void>(() => {});
  useEffect(() => {
    if (!canEdit) {
      setController(null);
      return;
    }
    setController({
      dirty,
      saving,
      canSave: allLoaded && baseHash !== null,
      save: () => saveRef.current(false),
      end: () => {
        location.hash = hrefs.columns();
      },
    });
    return () => setController(null);
  }, [canEdit, dirty, saving, allLoaded, baseHash, setController]);

  const update = (name: string, patch: Partial<DictionaryDraft>) => {
    setDraft((d) => ({ ...d, [name]: { ...(d[name] ?? EMPTY_DRAFT), ...patch } }));
    setDirtyKeys((keys) => new Set(keys).add(name));
  };

  const applyPaste = () => {
    const pasted = parseTsvRows(pasteText);
    const known = new Set(rows.map((r) => r.name));
    let applied = 0;
    setDraft((d) => {
      const next = { ...d };
      const nextDirty = new Set(dirtyKeys);
      for (const row of pasted) {
        if (!known.has(row.name)) continue;
        next[row.name] = applyPastedRow(next[row.name] ?? EMPTY_DRAFT, row);
        nextDirty.add(row.name);
        applied += 1;
      }
      setDirtyKeys(nextDirty);
      return next;
    });
    setPasteOpen(false);
    setPasteText("");
    addToast(t("columnsPage.pasteApplied", { n: applied }));
  };

  const save = async (force: boolean) => {
    if (saving || baseHash === null) return;
    const columns: Record<string, DictionaryDraft> = {};
    for (const [name, value] of Object.entries(draft)) {
      // 全フィールドが空のエントリは送らない（= 辞書から削除する。P §1.1）
      if (isEmptyDraft(value)) continue;
      columns[name] = { ...value, displayName: value.displayName.trim() };
    }
    setSaving(true);
    try {
      const res = await apiPut(wpath("/dictionary"), { baseHash, force, columns });
      if (res.status === 200) {
        const body = JSON.parse(res.body) as { revision: string; newHash: string };
        rememberOwnRevision(body.revision);
        setBaseHash(body.newHash);
        setDirtyKeys(new Set());
        await reloadDictionary(body.revision);
        addToast(t("tableEdit.saved"));
        // 保存後も編集は継続する（ER図・テーブル編集と同じ）
      } else if (res.status === 409) {
        setConflict(true);
      } else if (res.status === 422) {
        // タグ・色の検証エラー（P-12 / P-13）。どのカラムかが分かるよう path をそのまま出す
        const body = JSON.parse(res.body) as { errors?: { path: string; message: string }[] };
        const first = body.errors?.[0];
        addToast(
          first === undefined
            ? `${t("save.failed")} (HTTP 422)`
            : `${t("save.failed")}: ${first.path} — ${first.message}`,
        );
      } else if (res.status === 403) {
        // トークン不一致（§8.5）。HTTP コードだけ出しても次の手が分からない
        addToast(t("save.forbidden"));
      } else {
        addToast(`${t("save.failed")} (HTTP ${res.status})`);
      }
    } catch {
      addToast(`${t("save.failed")} (network)`);
    } finally {
      setSaving(false);
    }
  };

  saveRef.current = save;

  // N-10: Cmd/Ctrl+S で保存（ER図・テーブル編集と同じ）。編集ルートでのみ有効
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit]);

  const discard = () => {
    setDraft(draftsOf(dictionary));
    setDirtyKeys(new Set());
  };

  const reloadFromServer = async () => {
    setConflict(false);
    await reloadDictionary(String(Date.now()));
    const res = await apiGet(wpath("/dictionary"));
    if (res.status === 200) {
      setBaseHash((JSON.parse(res.body) as { baseHash: string }).baseHash);
    }
    discard();
  };

  const detailRow = detail === null ? undefined : rows.find((r) => r.name === detail);

  return (
    <div className={cx("catalog-page", "columns-page", styles.page)}>
      <div className="catalog-header">
        <h2>{t("columnsPage.title")}</h2>
        <span className="muted">{t("columnsPage.count", { n: rows.length })}</span>
        {/* 編集開始・保存・終了はヘッダ（EditControls）に集約 */}
      </div>
      <p className="muted form-hint">{t("columnsPage.hint")}</p>

      {canEdit && !allLoaded && (
        <div className="notice-banner">
          {t("columnsPage.loading", { loaded: loaded + failed, total })} — {t("columnsPage.saveWaiting")}
        </div>
      )}

      {focusColumn !== undefined && (
        <div className="notice-banner">
          {t("columnsPage.focusNotice", {
            name: focusColumn,
            match: t(`columnsPage.match.${focusMatch ?? "exact"}` as const),
          })}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setSearch("");
              setMatchMode("partial");
              location.hash = hrefs.columns();
            }}
          >
            {t("columnsPage.clearFocus")}
          </button>
        </div>
      )}

      <div className="columns-toolbar">
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">{t("columnsPage.filter.all")}</option>
          <option value="unset">{t("columnsPage.filter.unset")}</option>
          <option value="overridden">{t("columnsPage.filter.overridden")}</option>
          <option value="orphan">{t("columnsPage.filter.orphan")}</option>
        </select>
        <input
          type="search"
          className="catalog-filter"
          placeholder={t("columnsPage.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          value={matchMode}
          onChange={(e) => setMatchMode(e.target.value as MatchMode)}
          title={t("panel.lane.search")}
        >
          {MATCH_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`columnsPage.match.${m}` as const)}
            </option>
          ))}
        </select>
        {canEdit && (
          // 一括貼り付けは編集ユーティリティのためここに残す。保存・破棄・終了はヘッダへ集約
          <button type="button" className="header-button" onClick={() => setPasteOpen(true)}>
            {t("columnsPage.paste")}
          </button>
        )}
      </div>

      {/* 仮想化のビューポート。行は固定高（ROW_HEIGHT）で、範囲外はスペーサー行で埋める。
          器とヘッダ固定は ScrollTable と共用し、仮想化だけこの画面が持つ */}
      <ScrollTable
        fill
        scrollRef={scrollRef}
        testId="columns-scroll"
        tableClassName="columns-table"
        head={
          <tr>
            <th className={styles.nameCell}>{t("columnsPage.colName")}</th>
            <th>{t("columnsPage.colLogical")}</th>
            <th>{t("table.tags")}</th>
            <th className={styles.colorCell}>{t("tableEdit.color")}</th>
            <th className={styles.detailCell} />
          </tr>
        }
      >
        {plan.map((item, i) => {
          if (item.kind === "spacer") {
            // key は plan 内の位置（前後2つしか無く、行の入れ替わりでも安定する）
            return (
              <tr key={`spacer-${i}`} aria-hidden="true">
                <td colSpan={5} style={{ height: item.rows * ROW_HEIGHT, padding: 0 }} />
              </tr>
            );
          }
          const r = visible[item.index]!;
          const value = draft[r.name] ?? EMPTY_DRAFT;
          return (
            <tr
              key={r.name}
              className={cx(styles.row, dirtyKeys.has(r.name) && "row-dirty")}
              data-testid="columns-row"
              // 入力中の行を掴んでおく（仮想化で消えると入力・IME 変換が飛ぶ）
              onFocus={() => setActiveRow(r.name)}
            >
              <td className={cx("mono", styles.nameCell)}>
                {r.name}
                {/* 孤立エントリ（どのテーブルにも無い）だけは一覧に警告を残す。
                    理由の説明は詳細ダイアログで出す */}
                {r.occurrences === 0 && (
                  <button
                    type="button"
                    className={styles.orphanBadge}
                    title={t("columnsPage.orphan")}
                    aria-label={t("columnsPage.orphan")}
                    data-testid={`orphan-${r.name}`}
                    onClick={() => setDetail(r.name)}
                  >
                    ⚠
                  </button>
                )}
              </td>
              <td>
                {canEdit ? (
                  <input
                    type="text"
                    value={value.displayName}
                    placeholder={`（${t("table.notSet")}）`}
                    data-testid={`display-name-${r.name}`}
                    onChange={(e) => update(r.name, { displayName: e.target.value })}
                  />
                ) : (
                  <span className={value.displayName === "" ? "muted" : ""}>
                    {value.displayName === "" ? `（${t("table.notSet")}）` : value.displayName}
                  </span>
                )}
              </td>
              <td className={styles.tagCell}>
                {canEdit ? (
                  <TagInput
                    value={value.tags}
                    candidates={tagCandidates}
                    compact
                    nowrap
                    testId={`tags-${r.name}`}
                    onChange={(tags) => update(r.name, { tags })}
                  />
                ) : (
                  value.tags.map((tag) => (
                    <span key={tag} className={styles.tag}>
                      {tag}
                    </span>
                  ))
                )}
              </td>
              <td className={styles.colorCell}>
                {canEdit ? (
                  <ColorSelect
                    value={value.color}
                    testId={`color-cell-${r.name}`}
                    onChange={(color) => update(r.name, { color })}
                  />
                ) : (
                  value.color !== "" && (
                    <span
                      className={styles.swatch}
                      data-color={colorAttr(value.color)}
                      title={value.color}
                    />
                  )
                )}
              </td>
              <td className={styles.detailCell}>
                <button
                  type="button"
                  className={styles.detailButton}
                  title={t("columnsPage.detail.open")}
                  aria-label={t("columnsPage.detail.open")}
                  data-testid={`detail-${r.name}`}
                  onClick={() => setDetail(r.name)}
                >
                  🔍
                </button>
              </td>
            </tr>
          );
        })}
      </ScrollTable>

      {detailRow !== undefined && (
        <ColumnDetailDialog
          row={detailRow}
          draft={draft[detailRow.name] ?? EMPTY_DRAFT}
          canEdit={canEdit}
          tagCandidates={tagCandidates}
          onChange={(patch) => update(detailRow.name, patch)}
          onClose={() => setDetail(null)}
        />
      )}

      {pasteOpen && (
        <Dialog title={t("columnsPage.paste")} onClose={() => setPasteOpen(false)}>
          <p className="muted">{t("columnsPage.pasteHint")}</p>
          <textarea
            className="paste-area mono"
            rows={12}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={"created_at\t作成日時\t監査\tmuted\nupdated_at\t更新日時"}
          />
          <div className="dialog-actions">
            <button type="button" onClick={() => setPasteOpen(false)}>
              {t("dialog.cancel")}
            </button>
            <button type="button" className="primary" onClick={applyPaste}>
              {t("columnsPage.pasteApply")}
            </button>
          </div>
        </Dialog>
      )}

      {conflict && (
        <Dialog title={t("edit.conflict.title")} onClose={() => setConflict(false)}>
          <p>{t("columnsPage.conflictBody")}</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => void reloadFromServer()}>
              {t("edit.conflict.reload")}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setConflict(false);
                void save(true);
              }}
            >
              {t("edit.conflict.overwrite")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
