/**
 * テーブル画面の右ペイン `#/tables/<id>`（詳細）/ `#/tables/doc/<id>`（ドキュメント。R-01〜R-05）。
 *
 * どちらも、左パネルに並んでいるテーブル群（appStore.tablesPanelList）をその順序のまま
 * **1本のスクロール文書**として描く。違いは1テーブルの中身だけ:
 * - 詳細: TableInfo（カラム表・制約・被参照・配置ページ …）＋削除の導線
 * - ドキュメント: 見出し＋注記＋カラム表（物理名・論理名・タグ・注記）。型・キー・NULL は (i) に退避
 *
 * - 範囲は左パネルが決める（INV-1）。ここでは絞り込みを持たない。
 * - 論理名・色・タグの解決は TableInfo と同じ関数（logicalName.ts）を使う（INV-2）。
 * - DOM は範囲の全テーブル分を持つ（INV-5）。アンカー・Ctrl+F のため途中を間引かない。
 *   範囲が大きいときだけ、画面外のセクションを `content-visibility: auto` で描画から外す
 *   （境界で実寸化する分のかくつきがあるため、普段の範囲では全部描く）。
 * - スクロール追随で「読んでいる位置」が変わるたびに App・ヘッダ・左パネルが再描画されるので、
 *   ここと各セクションは memo にして、テーブル本体の再描画を巻き込まない。
 * - 論理情報（論理名・タグ・色・注記）の編集はペンから開くダイアログ（MetaEditDialog。
 *   ダイアログの積み重ねに載せ、App が描く）で、**確定＝即時保存**（saveTableMeta。E-11 と同じ経路。INV-3 / INV-4）。
 *
 * 左パネルとの連動（R-03）: URL の `<id>` と左パネルからのスクロール要求で見出しへ移動し、
 * 逆にスクロール位置の見出しを docActiveTableId に書いて左パネルの選択を追随させる。
 */
import { memo, useCallback, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";
import { colorAttr } from "../model/colors";
import { loadTable } from "../model/loader";
import {
  formatName,
  resolveColumnColor,
  resolveColumnName,
  resolveColumnTags,
  resolveTableName,
} from "../model/logicalName";
import type { MetaTarget } from "../model/metaTarget";
import { useAppStore, type TablesView } from "../model/store";
import type { Column, Dictionary, IndexTable, Table } from "../model/types";
import { cx } from "../lib/cx";
import { InfoPopover } from "../ui/InfoPopover";
import { Link } from "../ui/Link";
import { NotFound } from "../ui/NotFound";
import { hrefs } from "../ui/router";
import { ScrollTable } from "../ui/ScrollTable";
import { NotesPen, TableInfo, TableLink, TableMetaHeader } from "../ui/TableInfo";
import { TableDeleteSection } from "./TableDelete";
import { ViewSwitch } from "./ViewSwitch";
import styles from "./TablesDocument.module.scss";
// カラム表の行の色・タグ・キー標識は詳細（TableInfo）と同じ見た目にする。専用の複製は持たない
import infoStyles from "../ui/TableInfo.module.scss";

/** 見出しを上端にそろえるときの許容（px）。この範囲内なら「読んでいる位置」とみなす */
const SPY_TOLERANCE = 16;

/**
 * この数以上のテーブルを並べるときだけ、画面外のセクションの描画を省く（content-visibility）。
 * 省くと境界で推定高さから実寸へ切り替わる瞬間にかくつくので、普段の範囲（1ページ分）では使わない
 */
const LAZY_RENDER_FROM = 30;

/** 見出しへの合わせ直しを、文書の大きさの変化が止まってから終えるまでの時間（ms） */
const ALIGN_SETTLE_MS = 1500;

export const TablesDocument = memo(function TablesDocument({
  view,
  tableId,
  notice,
}: {
  view: TablesView;
  /** URL が指すテーブル（見出しへスクロールする） */
  tableId?: string;
  /** 上部に出す一時通知（静的モードで編集ルートから逃がされたとき） */
  notice?: string;
}) {
  const { t } = useI18n();
  const list = useAppStore((s) => s.tablesPanelList);
  const index = useAppStore((s) => s.index);
  const tables = useAppStore((s) => s.tables);
  const tableErrors = useAppStore((s) => s.tableErrors);
  const serverMode = useAppStore((s) => s.serverMode === true);
  const docActiveTableId = useAppStore((s) => s.docActiveTableId);
  const setDocActiveTableId = useAppStore((s) => s.setDocActiveTableId);
  const setLastTableId = useAppStore((s) => s.setLastTableId);
  const scrollRequest = useAppStore((s) => s.docScrollTo);
  const openDialog = useAppStore((s) => s.openDialog);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 貼り付いたバー。見出しはこの下端にそろう（CSS の scroll-margin-top と対応） */
  const barRef = useRef<HTMLDivElement>(null);

  // 範囲（index に無い ID は落とす。削除直後の一瞬など）
  const entries = useMemo(() => {
    const byId = new Map((index?.tables ?? []).map((it) => [it.id, it] as const));
    return list.ids.map((id) => byId.get(id)).filter((it): it is IndexTable => it !== undefined);
  }, [list, index]);
  const idsKey = entries.map((it) => it.id).join("\n");

  /** 右ペインのスクロール要素（App の .app-content）。見出しの位置はこれを基準に測る */
  const scrollerOf = (): HTMLElement | null =>
    rootRef.current?.closest<HTMLElement>("[data-scroll-root]") ?? null;

  /**
   * 見出しへ移動した後、その**上にある**テーブルがまだ読み込み中なら覚えておく。
   * 上のセクションは読み込みが済むと推定高さから実寸へ変わり、目的の見出しがずれる。
   * 上が全部読めるまで、読めるたびに合わせ直す（下のセクションは位置に影響しないので待たない）
   */
  const settling = useRef<string | null>(null);

  /** 進行中の合わせ直しを止める関数。次の移動が始まったとき・離れるときに呼ぶ */
  const stopAlign = useRef<() => void>(() => {});

  /**
   * 見出しを上端（バーの下端）へ合わせる。
   *
   * 1回の scrollIntoView では決まらない: 上のセクションは読み込み中の仮表示や
   * `content-visibility: auto` の推定高さで置かれており、読み込み・描画が進むと実寸に変わって
   * 目的の見出しがずれる（フォントの差し替えでも動く）。目的のセクション自身が最後で
   * まだ小さいと、末尾で止まって届かないこともある。そこで、移動後しばらくは文書の大きさの変化
   * （ResizeObserver）を見張り、**こちらが置いたスクロール位置のまま**で見出しが上端から外れて
   * いれば合わせ直す。人がその間にスクロールしていれば（位置が変わっている）手を出さず、
   * ホイール・タッチ・キーの入力があれば打ち切る。変化が止まって少し経ったら終える
   */
  const alignTo = useCallback((el: HTMLElement): void => {
    stopAlign.current();
    const scroller = scrollerOf();
    const root = rootRef.current;
    /** 見出しの上端と、そろえる先（バーの下端）とのずれ */
    const offset = (): number =>
      el.getBoundingClientRect().top - (barRef.current?.getBoundingClientRect().bottom ?? 0);
    el.scrollIntoView({ block: "start" });
    let placed = scroller?.scrollTop ?? 0;
    let timer = 0;
    const stop = (): void => {
      window.clearTimeout(timer);
      observer.disconnect();
      for (const ev of ["wheel", "touchstart", "keydown"]) scroller?.removeEventListener(ev, stop);
      stopAlign.current = () => {};
    };
    // 変化が止まってからこの時間だけ待って終える（読み込みの間隔より長め）
    const armTimer = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(stop, ALIGN_SETTLE_MS);
    };
    const observer = new ResizeObserver(() => {
      if (!el.isConnected) {
        stop();
        return;
      }
      const untouched = (scroller?.scrollTop ?? 0) === placed;
      if (untouched && Math.abs(offset()) > 1) {
        el.scrollIntoView({ block: "start" });
        placed = scroller?.scrollTop ?? 0;
      }
      armTimer();
    });
    if (root !== null) observer.observe(root);
    for (const ev of ["wheel", "touchstart", "keydown"]) {
      scroller?.addEventListener(ev, stop, { passive: true });
    }
    armTimer();
    stopAlign.current = stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => stopAlign.current(), []);

  /** 見出しへ移動し、読んでいる位置もそこに合わせる（スクロール追随を待たない） */
  const jump = useCallback(
    (id: string): boolean => {
      const el = rootRef.current?.querySelector<HTMLElement>(
        `[data-doc-table="${CSS.escape(id)}"]`,
      );
      if (el === null || el === undefined) return false;
      alignTo(el);
      settling.current = id;
      setDocActiveTableId(id);
      setLastTableId(id);
      return true;
    },
    [alignTo, setDocActiveTableId, setLastTableId],
  );

  // 目的の見出しより上で読み込みが済んだ数 / 上の総数。済んだ数が変わるたびに合わせ直し、
  // 全部済んだ時点の合わせ直しを最後にして終える
  const settleTarget = settling.current;
  const above = useMemo(() => {
    if (settleTarget === null) return { done: -1, total: 0 };
    const at = entries.findIndex((it) => it.id === settleTarget);
    if (at < 0) return { done: -1, total: 0 };
    const upper = entries.slice(0, at);
    const done = upper.filter((it) => tables[it.id] !== undefined || tableErrors[it.id] !== undefined);
    return { done: done.length, total: upper.length };
  }, [settleTarget, entries, tables, tableErrors]);
  useEffect(() => {
    const id = settling.current;
    if (id === null || above.done < 0) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-doc-table="${CSS.escape(id)}"]`);
    if (el !== null && el !== undefined) alignTo(el);
    if (above.done === above.total) settling.current = null;
    // 済んだ数が変わったときだけ（下のテーブルの読み込みでは動かさない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [above.done, above.total]);

  // URL の <id> が変わったら（着地・左パネルのクリック・表示モードの切替）その見出しへ。
  // 範囲に無くても「読んでいる位置」はそのテーブルにする: 左パネルがそのテーブルの載っている
  // ページを選び直し（useTablesPanelPage）、範囲が変わった時点で下の効果が見出しへ運ぶ
  // 表示モードの切替（view）でもやり直す: URL の <id> が同じままセクションの高さが変わり、位置がずれる
  useEffect(() => {
    if (tableId === undefined) return;
    if (!jump(tableId)) {
      setDocActiveTableId(tableId);
      setLastTableId(tableId);
    }
  }, [tableId, view, jump, setDocActiveTableId, setLastTableId]);

  // 左パネルからの要求（同じテーブルを続けて押しても効くよう、URL とは別に受ける）
  useEffect(() => {
    if (scrollRequest !== null) jump(scrollRequest.id);
  }, [scrollRequest, jump]);

  // 範囲が変わったら、読んでいた位置が残っていればそこへ、無ければ先頭へ。
  // 着地直後は左パネルの公開より先にここが描かれるため、読んでいた位置の代わりに URL の <id> を使う
  const prevKey = useRef(idsKey);
  useEffect(() => {
    if (prevKey.current === idsKey) return;
    prevKey.current = idsKey;
    const keep = useAppStore.getState().docActiveTableId ?? tableId;
    if (keep !== undefined && jump(keep)) return;
    scrollerOf()?.scrollTo({ top: 0 });
  }, [idsKey, tableId, jump]);

  // スクロール追随（R-03）: バーの下端に最も近い（その上にある）見出しを「読んでいる位置」にする
  useEffect(() => {
    const scroller = scrollerOf();
    if (scroller === null) return;
    let raf = 0;
    const update = (): void => {
      raf = 0;
      // 見出しは貼り付いたバーの下にそろう（scroll-margin-top）ので、バーの下端を基準にする
      const top = barRef.current?.getBoundingClientRect().bottom ?? scroller.getBoundingClientRect().top;
      const sections = rootRef.current?.querySelectorAll<HTMLElement>("[data-doc-table]") ?? [];
      let current: string | undefined;
      for (const el of sections) {
        if (el.getBoundingClientRect().top - top <= SPY_TOLERANCE) current = el.dataset["docTable"];
        else break;
      }
      current ??= sections[0]?.dataset["docTable"];
      if (current === undefined) return;
      const st = useAppStore.getState();
      if (st.docActiveTableId !== current) {
        st.setDocActiveTableId(current);
        st.setLastTableId(current);
      }
    };
    const onScroll = (): void => {
      if (raf === 0) raf = requestAnimationFrame(update);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [idsKey]);

  // 離れたら読んでいた位置は忘れる（次に入るときは URL の <id> から始める）。
  // スクロール要素はほかの画面と共用なので、途中の位置を持ち越さないよう先頭へ戻す
  // （クリーンアップの時点では ref が外れているため、要素はマウント時に取っておく）
  useEffect(() => {
    const scroller = scrollerOf();
    return () => {
      setDocActiveTableId(null);
      scroller?.scrollTo({ top: 0 });
    };
  }, [setDocActiveTableId]);

  // ペンが押されたら論理情報ダイアログを開く（R-05。ダイアログと保存は MetaEditDialog が持つ）
  const openMeta = useCallback(
    (target: MetaTarget): void => openDialog({ type: "meta", target }),
    [openDialog],
  );

  // URL が存在しないテーブルを指している（B-11）
  if (index !== null && tableId !== undefined && !index.tables?.some((it) => it.id === tableId)) {
    return <NotFound path={`tables/${tableId}`} />;
  }

  const activeForSwitch = docActiveTableId ?? tableId;

  return (
    <div className={styles.doc} ref={rootRef} data-testid="tables-document" data-view={view}>
      <div className={styles.bar} ref={barRef}>
        <ViewSwitch view={view} tableId={activeForSwitch} />
        <span className={styles.range} data-testid="doc-range">
          {list.label}
        </span>
        <span className={cx("muted", styles.count)} data-testid="doc-count">
          {t("doc.range.count", { n: entries.length })}
        </span>
      </div>
      {notice !== undefined && <div className="notice-banner">{notice}</div>}
      {entries.length === 0 ? (
        <div className="empty-state">
          <p>{t("doc.empty")}</p>
        </div>
      ) : (
        entries.map((it) => (
          <TableSection
            key={it.id}
            entry={it}
            view={view}
            canEdit={serverMode}
            lazy={entries.length >= LAZY_RENDER_FROM}
            onEditMeta={openMeta}
          />
        ))
      )}
    </div>
  );
});

// ------------------------------------------------------------------ 1テーブル分のセクション

/** セクションの推定高さ（px）。画面外の contain-intrinsic-size に使う（見出し + 行数 × 行高 + 詳細の付随情報） */
function estimateHeight(view: TablesView, columns: number | undefined): number {
  const rows = columns ?? 8;
  return view === "detail" ? 420 + 46 * rows : 150 + 42 * rows;
}

const TableSection = memo(function TableSection({
  entry,
  view,
  canEdit,
  lazy,
  onEditMeta,
}: {
  entry: IndexTable;
  view: TablesView;
  canEdit: boolean;
  /** 画面外の描画を省くか（範囲が大きいときだけ） */
  lazy: boolean;
  onEditMeta: (target: MetaTarget) => void;
}) {
  const { t } = useI18n();
  const stored = useAppStore((s) => s.tables[entry.id]);
  const error = useAppStore((s) => s.tableErrors[entry.id]);
  const dictionary = useAppStore((s) => s.dictionary);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  /**
   * 一度読めたテーブルは手元に残す。注記の保存（saveTableMeta）は読み直しのため一瞬
   * ストアから消すので、素直に追随すると保存のたびにセクションが「読み込み中」へ縮んで
   * スクロール位置が跳ぶ
   */
  const held = useRef<Table | null>(null);
  if (stored !== undefined) held.current = stored;
  const table = stored ?? held.current;

  useEffect(() => {
    void loadTable(entry.id);
  }, [entry.id]);

  // 見出しは詳細画面と同じ（表示形式の設定に従う。物理名は ID として常に併記される）
  const title = formatName(
    resolveTableName(entry.name, table?.meta?.displayName ?? entry.displayName),
    entry.name,
    nameDisplay,
  );
  const style = { "--doc-est": `${estimateHeight(view, entry.columns)}px` } as CSSProperties;

  return (
    <section
      className={cx(styles.section, lazy && styles.lazy)}
      data-doc-table={entry.id}
      data-testid="doc-section"
      style={style}
    >
      <div className="catalog-header">
        <h2>{title}</h2>
        <span className="mono muted">{entry.id}</span>
        {view === "doc" && table !== null && (
          <span className={styles.headActions}>
            <InfoPopover
              content={<TableFacts table={table} entry={entry} />}
              icon={<InfoIcon />}
              label={t("doc.showInfo")}
              testId={`doc-table-info-${entry.id}`}
              dialogTitle={
                <>
                  {title} <span className="mono muted">{entry.id}</span>
                </>
              }
            />
          </span>
        )}
      </div>
      {view === "detail" ? (
        <>
          <TableInfo tableId={entry.id} fullHeight canEdit={canEdit} />
          {/* 削除（J-02）は本文の下。誤って逆生成したテーブルを個別に消す唯一の導線 */}
          <TableDeleteSection tableId={entry.id} />
        </>
      ) : error !== undefined ? (
        <p className="error-text">{t("table.loadError", { error })}</p>
      ) : table === null ? (
        <p className="muted">{t("table.loading")}</p>
      ) : (
        <>
          <TableMetaHeader
            table={table}
            showEmptyNotes
            onEdit={canEdit ? () => onEditMeta({ kind: "table", tableId: entry.id }) : undefined}
            editTestId={`doc-table-meta-edit-${entry.id}`}
          />
          <h3 className={styles.columnsHeading}>{t("table.columns")}</h3>
          {/* 表の器・濃色ヘッダ・行の体裁は詳細（TableInfo）と同じ ScrollTable。高さ制限は付けない */}
          <ScrollTable
            testId="doc-columns"
            head={
              <tr>
                <th>{t("table.colName")}</th>
                <th>{t("table.colLogicalName")}</th>
                <th>{t("table.tags")}</th>
                <th className={styles.notesHead}>{t("table.colNotes")}</th>
                {/* 末尾は行の編集ペンの専用列（サーバーモードのみ。行にホバーしたときだけ見える） */}
                {canEdit && <th className={infoStyles.editCell} aria-label={t("doc.editColumnMeta")} />}
              </tr>
            }
          >
            {table.columns.map((c) => (
              <ColumnRow
                key={c.name}
                table={table}
                column={c}
                dictionary={dictionary}
                canEdit={canEdit}
                onEditMeta={onEditMeta}
              />
            ))}
          </ScrollTable>
        </>
      )}
    </section>
  );
});

function ColumnRow({
  table,
  column: c,
  dictionary,
  canEdit,
  onEditMeta,
}: {
  table: Table;
  column: Column;
  dictionary: Dictionary | null;
  canEdit: boolean;
  onEditMeta: (target: MetaTarget) => void;
}) {
  const { t } = useI18n();
  const logical = resolveColumnName(table, c.name, dictionary);
  // 色は個別 → 辞書、タグは辞書 ∪ 個別。表示では出どころを区別しない（P-12 / P-13）
  const color = resolveColumnColor(table, c.name, dictionary).color;
  const tags = resolveColumnTags(table, c.name, dictionary).tags;
  const notes = table.meta?.columns?.[c.name]?.notes ?? "";
  return (
    <tr className={infoStyles.columnRow} data-color={colorAttr(color)} data-testid="doc-column-row">
      <td>
        <span className={styles.physCell}>
          <span className="mono">{c.name}</span>
          <InfoPopover
            content={<ColumnFacts table={table} column={c} dictionary={dictionary} />}
            icon={<InfoIcon />}
            label={t("doc.showInfo")}
            testId={`doc-column-info-${c.name}`}
            dialogTitle={
              <>
                <span className="mono">{c.name}</span>
                {logical.source !== "physical" && <span className={styles.dialogLogical}>{logical.name}</span>}
              </>
            }
          />
        </span>
      </td>
      <td>
        {logical.source === "physical" ? (
          <span className="muted">（{t("table.notSet")}）</span>
        ) : (
          <>
            {logical.name}
            {logical.source === "dictionary" && <span className="badge badge-dict">辞書</span>}
          </>
        )}
      </td>
      <td>
        {tags.length > 0 && (
          <span className={infoStyles.columnTags}>
            {tags.map((tag) => (
              <span key={tag} className={infoStyles.tag}>
                {tag}
              </span>
            ))}
          </span>
        )}
      </td>
      <td>
        {/* 行では空を「注記なし」と書かない（毎行に並ぶと読みの邪魔になる） */}
        <span className={styles.notesText} data-testid={notes !== "" ? "doc-column-notes" : undefined}>
          {notes}
        </span>
      </td>
      {canEdit && (
        <td className={cx("center", infoStyles.editCell)}>
          <NotesPen
            label={t("doc.editColumnMeta")}
            testId={`doc-column-meta-edit-${c.name}`}
            hover
            onClick={() => onEditMeta({ kind: "column", tableId: table.id, column: c.name })}
          />
        </td>
      )}
    </tr>
  );
}

// ------------------------------------------------------------------ (i) の中身（R-04）

/** 定義リストの1項目。値が無ければ出さない */
function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  if (children === null || children === undefined || children === false || children === "") return null;
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ColumnFacts({
  table,
  column: c,
  dictionary,
}: {
  table: Table;
  column: Column;
  dictionary: Dictionary | null;
}) {
  const { t } = useI18n();
  const pk = (table.primaryKey ?? []).includes(c.name);
  const fks = (table.foreignKeys ?? []).filter((fk) => fk.columns.includes(c.name));
  const lfks = (table.meta?.logicalForeignKeys ?? []).filter((fk) => fk.columns.includes(c.name));
  const unique =
    (table.uniques ?? []).some((u) => u.columns.length === 1 && u.columns[0] === c.name) ||
    (table.meta?.logicalUniques ?? []).some((u) => u.columns.length === 1 && u.columns[0] === c.name);
  const tags = resolveColumnTags(table, c.name, dictionary).tags;
  const hasKey = pk || fks.length > 0 || lfks.length > 0 || unique;
  return (
    <dl className={styles.facts}>
      <Fact label={t("doc.info.key")}>
        {hasKey && (
          <span className={styles.keys}>
            {pk && <span className={cx(infoStyles.keyBadge, infoStyles.keyPk)}>PK</span>}
            {fks.map((fk, i) => (
              <span key={`fk-${i}`} className={styles.keyRef}>
                <span className={cx(infoStyles.keyBadge, infoStyles.keyFk)}>FK</span>
                <TableLink tableId={fk.ref.table} />
              </span>
            ))}
            {lfks.map((fk, i) => (
              <span key={`lfk-${i}`} className={styles.keyRef}>
                <span className={cx(infoStyles.keyBadge, infoStyles.keyFk)}>FK</span>
                <TableLink tableId={fk.ref.table} />
                <span className="badge badge-logical">{t("table.logicalForeignKeys")}</span>
              </span>
            ))}
            {unique && <span className={cx(infoStyles.keyBadge, styles.keyUnique)}>{t("doc.info.unique")}</span>}
          </span>
        )}
      </Fact>
      <Fact label={t("table.colType")}>
        <span className="mono">{c.type ?? c.logicalType ?? ""}</span>
        {c.type !== undefined && c.logicalType !== undefined && c.logicalType !== c.type && (
          <span className="mono muted"> ({c.logicalType})</span>
        )}
        {c.autoIncrement === true && <span className="badge">{t("table.autoIncrement")}</span>}
        {c.generated === true && <span className="badge">{t("table.generated")}</span>}
      </Fact>
      <Fact label={t("table.colNullable")}>{c.nullable === true ? t("common.yes") : t("common.no")}</Fact>
      <Fact label={t("table.colDefault")}>
        {c.default !== undefined && <span className="mono">{String(c.default)}</span>}
      </Fact>
      <Fact label={t("table.colComment")}>{c.comment ?? ""}</Fact>
      <Fact label={t("table.tags")}>
        {tags.length > 0 &&
          tags.map((tag) => (
            <span key={tag} className={infoStyles.tag}>
              {tag}
            </span>
          ))}
      </Fact>
    </dl>
  );
}

function TableFacts({ table, entry }: { table: Table; entry: IndexTable }) {
  const { t } = useI18n();
  const manifest = useAppStore((s) => s.manifest);
  const pages = entry.diagrams ?? [];
  const pageTitle = (id: string): string => manifest?.diagrams?.find((d) => d.id === id)?.title ?? id;
  const count = (n: number | undefined): string => (n ? t("doc.info.count", { n }) : t("doc.info.none"));
  return (
    <dl className={styles.facts}>
      <Fact label={t("table.primaryKey")}>
        {(table.primaryKey?.length ?? 0) > 0 && <span className="mono">{table.primaryKey?.join(", ")}</span>}
      </Fact>
      <Fact label={t("table.uniques")}>{count(table.uniques?.length)}</Fact>
      <Fact label={t("table.indexes")}>{count(table.indexes?.length)}</Fact>
      <Fact label={t("table.foreignKeys")}>{count(table.foreignKeys?.length)}</Fact>
      <Fact label={t("table.logicalUniques")}>{count(table.meta?.logicalUniques?.length)}</Fact>
      <Fact label={t("table.logicalForeignKeys")}>{count(table.meta?.logicalForeignKeys?.length)}</Fact>
      <Fact label={t("table.colComment")}>{table.comment ?? ""}</Fact>
      <Fact label={t("table.pages")}>
        {pages.length === 0 ? (
          <span className="muted">{t("table.unplacedNote")}</span>
        ) : (
          <span className={styles.pages}>
            {pages.map((d) => (
              <Link key={d} href={hrefs.erd(d, entry.id)}>
                {pageTitle(d)}
              </Link>
            ))}
          </span>
        )}
      </Fact>
    </dl>
  );
}

function InfoIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <circle cx="12" cy="7.8" r="0.6" fill="currentColor" />
    </svg>
  );
}
