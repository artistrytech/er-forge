/**
 * 論理制約（論理一意制約 P-06 / 論理外部制約 P-07）の作成・編集ダイアログと、一覧の1行。
 *
 * 以前は編集フォームの中で1制約 = 1行のインライン編集にしていたが、複合キーになると
 * 横方向に伸び続け、**どのカラムがどのカラムに対応するのか**が読めなくなっていた。
 * ここでは一覧は要約表示に徹し、作成・編集はダイアログで行う。
 *
 * 論理外部制約のカラム対応は「1行 = 1組（自カラム → 参照先カラム）」の**縦に伸びる**表にする。
 * 対応が行として揃うため、両側の本数がずれること（COUNT_MISMATCH）も構造的に起こらない。
 * ダイアログは確定できる状態になるまで [確定] を押させない（保存時に初めて怒られない）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/useI18n";
import { loadTable } from "../model/loader";
import {
  EMPTY_CARDINALITY,
  generateConstraintName,
  isAutoCardinality,
  newUid,
  type DraftCardinality,
  type DraftLogicalFk,
  type DraftLogicalUnique,
} from "../model/metaDraft";
import { formatName, resolveIndexTableName } from "../model/logicalName";
import { useAppStore } from "../model/store";
import type { CardEnd, ForeignKey, IndexTable, Table } from "../model/types";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { cx } from "../lib/cx";
import styles from "./ConstraintDialog.module.scss";

// ------------------------------------------------------------------ 一覧

/** 制約の一覧（0件のときは「まだありません」と出す。空の <ul> を残さない） */
export function ConstraintList({ empty, children }: { empty: boolean; children: React.ReactNode }) {
  const { t } = useI18n();
  if (empty) return <p className={styles.empty}>{t("tableEdit.noConstraints")}</p>;
  return <ul className={styles.list}>{children}</ul>;
}

// ------------------------------------------------------------------ 一覧の1行

/**
 * 制約1件の要約行。名前・構成・注記を読むためだけの行で、変更は [編集] から行う。
 * 名前が未入力の制約は保存時に自動生成されるため、その予定名を薄く見せる。
 */
export function ConstraintRow({
  name,
  autoName = "",
  detail,
  notes,
  hasError,
  badge,
  editLabel,
  testId,
  onEdit,
  onRemove,
}: {
  name: string;
  /** 名前が空のときに保存で付く名前（プレビュー）。名前が必ずある制約では不要 */
  autoName?: string;
  detail: React.ReactNode;
  notes: string;
  hasError: boolean;
  /** 名前の右に出す印（カーディナリティを明示設定しているか。P-11） */
  badge?: React.ReactNode;
  editLabel?: string;
  testId: string;
  onEdit: () => void;
  /** 省略すると [削除] を出さない（物理FK は消せない = machine-owned） */
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const named = name.trim() !== "";
  return (
    <li className={cx(styles.row, hasError && styles.rowError)} data-testid={testId}>
      <div className={styles.rowMain}>
        <div className={styles.rowHead}>
          <span className={cx("mono", styles.rowName, !named && styles.rowNameAuto)}>
            {named ? name.trim() : autoName}
          </span>
          {!named && <span className={styles.rowAutoBadge}>{t("tableEdit.autoNamed")}</span>}
          {badge}
          {hasError && <span className="field-error">⚠</span>}
        </div>
        <div className={cx("mono", styles.rowDetail)}>{detail}</div>
        {notes.trim() !== "" && <div className={styles.rowNotes}>{notes}</div>}
      </div>
      <div className={styles.rowActions}>
        <Button data-testid={`${testId}-edit`} onClick={onEdit}>
          {editLabel ?? t("tableEdit.edit")}
        </Button>
        {onRemove !== undefined && (
          <Button variant="danger" data-testid={`${testId}-remove`} onClick={onRemove}>
            {t("tableEdit.remove")}
          </Button>
        )}
      </div>
    </li>
  );
}

/** カーディナリティを明示設定している制約に付ける印（一覧でひと目で分かるように。P-11） */
export function CardinalityBadge({ value }: { value: DraftCardinality }) {
  const { t } = useI18n();
  if (isAutoCardinality(value)) return null;
  // 片側だけの上書きもあるため、上書きしていない側は「自動」と出す（親 / 子 の順）
  const auto = t("tableEdit.autoShort");
  const text =
    value.parent === "" && value.child === ""
      ? t("tableEdit.cardinalityNotesOnly")
      : `${value.parent === "" ? auto : value.parent} / ${value.child === "" ? auto : value.child}`;
  return (
    <span className={styles.cardBadge} data-testid="cardinality-badge" title={t("relation.explicit")}>
      {text}
    </span>
  );
}

/**
 * 論理外部制約の要約（一覧用）。複合キーは1組ずつ改行して並べる
 * （`(a, b) → T (x, y)` と1行に畳むと、どのカラムがどれに対応するのか読めないため）。
 */
export function FkDetail({ fk }: { fk: DraftLogicalFk }) {
  const { t } = useI18n();
  if (fk.refTable === "") return <>{t("tableEdit.noRefTable")}</>;
  const n = Math.max(fk.columns.length, fk.refColumns.length);
  if (n === 0) return <>{`→ ${fk.refTable}`}</>;
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={styles.detailPair}>
          <span>{fk.columns[i] ?? "?"}</span>
          <span className={styles.pairArrow} aria-hidden="true">
            →
          </span>
          <span>{`${fk.refTable}.${fk.refColumns[i] ?? "?"}`}</span>
        </div>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ 共通の部品

/** 制約名の入力（空なら自動生成。他の制約と同じ名前は付けさせない） */
function NameField({
  value,
  autoName,
  duplicate,
  onChange,
  testId,
}: {
  value: string;
  autoName: string;
  duplicate: boolean;
  onChange: (v: string) => void;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{t("tableEdit.constraintName")}</span>
      <input
        type="text"
        className={cx("mono", styles.input, duplicate && styles.inputError)}
        data-testid={testId}
        placeholder={autoName}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className={styles.fieldHint}>
        {duplicate ? (
          <span className={styles.errorText}>{t("tableEdit.nameDuplicate")}</span>
        ) : (
          t("tableEdit.autoNameHint", { name: autoName })
        )}
      </span>
    </label>
  );
}

function NotesField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{t("tableEdit.notes")}</span>
      <input
        type="text"
        className={styles.input}
        data-testid="constraint-notes"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * カーディナリティの上書き（P-11）。物理FK・論理外部制約のどちらのダイアログでも同じ枠を使う。
 *
 * 親側に `0..N` / `1..N` は出さない（参照先は必ず1件を指すため。詳細設計 §5.3）。
 * 「現在の解決値」は **保存済みの index.js から引く**。導出（NOT NULL / 一意制約からの判定）は
 * サーバーが持つ唯一の実装であり、ビューアには複製しない（Phase0 §5）。そのため、
 * まだ保存していない制約や、カラム構成を変えた直後は解決値を出せない。
 */
export function CardinalityFields({
  value,
  relationId,
  onChange,
}: {
  value: DraftCardinality;
  /** 解決値を引くためのリレーションID（`<テーブルID>#<種別>:<制約名>`）。未保存なら null */
  relationId: string | null;
  onChange: (next: DraftCardinality) => void;
}) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const relation =
    relationId === null ? undefined : (index?.relations ?? []).find((r) => r.id === relationId);
  const resolved = relation?.cardinality;

  const end = (side: "parent" | "child", options: CardEnd[]) => (
    <label className={styles.cardCell}>
      <span className={styles.cardCellLabel}>
        {side === "parent" ? t("relation.parentSide") : t("relation.childSide")}
      </span>
      <select
        className={cx("mono", styles.select)}
        data-testid={`cardinality-${side}`}
        value={value[side]}
        onChange={(e) => onChange({ ...value, [side]: e.target.value as "" | CardEnd })}
      >
        <option value="">{t("tableEdit.auto")}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className={styles.field} data-testid="cardinality-fields">
      <span className={styles.fieldLabel}>{t("relation.cardinality")}</span>
      <span className={styles.fieldHint}>{t("tableEdit.cardinalityHint")}</span>
      <div className={styles.cardRow}>
        {end("parent", ["0..1", "1..1"])}
        {end("child", ["0..1", "1..1", "0..N", "1..N"])}
      </div>
      <span className={styles.fieldHint} data-testid="cardinality-resolved">
        {resolved === undefined
          ? t("tableEdit.derivedPending")
          : t("tableEdit.derivedNowValue", {
              parent: resolved.parent ?? "?",
              child: resolved.child ?? "?",
            })}
      </span>
      <input
        type="text"
        className={styles.input}
        data-testid="cardinality-notes"
        placeholder={t("tableEdit.cardinalityNotes")}
        value={value.notes}
        onChange={(e) => onChange({ ...value, notes: e.target.value })}
      />
    </div>
  );
}

/** [確定]（確定できないときは理由を出したまま押させない）＋ [キャンセル] */
function DialogActions({
  blocked,
  editing,
  busy = false,
  error,
  extraActions,
  onSubmit,
  onClose,
}: {
  /** 確定できない理由（null なら確定できる） */
  blocked: string | null;
  editing: boolean;
  /** 保存中（ER図からの即時保存。二重送信を防ぐ） */
  busy?: boolean;
  /** 保存に失敗した理由。入力を失わせないため、ダイアログは閉じずにここへ出す */
  error?: string | null;
  extraActions?: React.ReactNode;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {blocked !== null && <p className={styles.blockedHint}>{blocked}</p>}
      {error !== null && error !== undefined && error !== "" && (
        <p className={styles.submitError} data-testid="constraint-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <Button
          variant="primary"
          data-testid="constraint-submit"
          disabled={blocked !== null || busy}
          onClick={onSubmit}
        >
          {busy ? t("tableEdit.saving") : editing ? t("tableEdit.applyEdit") : t("tableEdit.applyAdd")}
        </Button>
        <Button onClick={onClose}>{t("layout.cancel")}</Button>
        {extraActions}
      </div>
    </>
  );
}

/** 行を1つ増減させる縦並びの枠（一意制約のカラム / 外部制約のカラム対応で共用） */
function RowList({
  children,
  addLabel,
  addTestId,
  onAdd,
}: {
  children: React.ReactNode;
  addLabel: string;
  addTestId: string;
  onAdd: () => void;
}) {
  return (
    <div className={styles.rowList}>
      {children}
      <button type="button" className={styles.addRow} data-testid={addTestId} onClick={onAdd}>
        {addLabel}
      </button>
    </div>
  );
}

interface PairRow {
  uid: number;
  column: string;
  refColumn: string;
}

/**
 * 参照先テーブルの選択。**選ぶ前**と**選んだ後**で見た目を変える。
 *
 * - 選ぶ前: 絞り込みの入力だけを置き、**入力欄にフォーカスしている間だけ**候補を
 *   フローティングで出す。クリック（または候補が1件なら Enter）で確定する
 *   （テーブルが増えても、畳んだ選択肢の中を探し回らずに済む）
 * - 選んだ後: 確定したテーブルを入力不可で見せるだけ。候補は出さない
 *   （確定済みの値が、うっかり別のテーブルに変わらないように）。解除は [×] から
 *
 * 候補は TagInput と同じく **body 直下へのポータル + 実測アンカー**で出す。
 * ダイアログ本文は `overflow-y: auto` なので、中に絶対配置すると切り取られてしまう。
 */
function RefTablePicker({
  selfId,
  value,
  onSelect,
  onClear,
}: {
  /** 編集中のテーブル（自己参照の注記に使う） */
  selfId: string;
  /** 確定済みの参照先テーブル ID（"" = 未確定） */
  value: string;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const [filter, setFilter] = useState("");
  const [focused, setFocused] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // [×] で解除した直後は、そのまま選び直せるように入力欄へ戻す
  const refocus = useRef(false);

  const tables = index?.tables ?? [];
  const label = (it: IndexTable): string =>
    formatName(resolveIndexTableName(it), it.name, nameDisplay);

  // 名称（論理名・物理名・ID）での絞り込み
  const q = filter.trim().toLowerCase();
  const candidates = tables.filter(
    (it) =>
      q === "" ||
      it.id.toLowerCase().includes(q) ||
      it.name.toLowerCase().includes(q) ||
      resolveIndexTableName(it).name.toLowerCase().includes(q),
  );
  const open = value === "" && focused;

  useEffect(() => {
    if (value === "" && refocus.current) {
      refocus.current = false;
      inputRef.current?.focus();
    }
  }, [value]);

  // 候補は固定配置なので、入力欄の位置を測って渡す（スクロール・リサイズにも追随させる）
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const measure = (): void => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (rect !== undefined) setAnchor(rect);
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, candidates.length]);

  /** 下に入りきらないときは上に出す（画面外に垂れ流さない） */
  const listStyle = (): React.CSSProperties => {
    if (anchor === null) return { visibility: "hidden" };
    const below = window.innerHeight - anchor.bottom;
    const openUp = below < 240 && anchor.top > below;
    return {
      left: anchor.left,
      width: anchor.width,
      ...(openUp
        ? { bottom: window.innerHeight - anchor.top + 2, maxHeight: Math.max(120, anchor.top - 12) }
        : { top: anchor.bottom + 2, maxHeight: Math.max(120, below - 12) }),
    };
  };

  if (value !== "") {
    const selected = tables.find((it) => it.id === value);
    const text = selected === undefined ? value : label(selected);
    return (
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("tableEdit.refTable")}</span>
        <div className={styles.refSelected}>
          <input
            type="text"
            className={cx(styles.input, styles.refSelectedInput)}
            data-testid="fk-ref-table"
            data-table-id={value}
            readOnly
            value={text}
          />
          <button
            type="button"
            className={styles.removeRow}
            data-testid="fk-ref-clear"
            aria-label={t("tableEdit.refTableClear")}
            title={t("tableEdit.refTableClear")}
            onClick={() => {
              setFilter("");
              refocus.current = true;
              onClear();
            }}
          >
            ×
          </button>
        </div>
        <span className={styles.fieldHint}>
          {value === selfId ? `${value}（${t("tableEdit.selfRef")}）` : value}
        </span>
      </div>
    );
  }

  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>
        {t("tableEdit.refTable")}
        {open && (
          <span className={styles.fieldCount}>{t("catalog.count", { n: candidates.length })}</span>
        )}
      </span>
      <input
        ref={inputRef}
        type="search"
        className={styles.input}
        data-testid="fk-ref-filter"
        role="combobox"
        aria-expanded={open}
        aria-controls="fk-ref-list"
        placeholder={t("tableEdit.refTableFilter")}
        value={filter}
        // 1件まで絞れているなら Enter でそのまま確定できる（一覧まで手を伸ばさせない）
        onKeyDown={(e) => {
          if (e.key === "Enter" && candidates.length === 1) {
            e.preventDefault();
            onSelect(candidates[0]!.id);
          }
        }}
        onChange={(e) => setFilter(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {open &&
        createPortal(
          <ul
            className={styles.refList}
            id="fk-ref-list"
            role="listbox"
            data-testid="fk-ref-list"
            style={listStyle()}
          >
            {candidates.length === 0 ? (
              <li className={styles.refEmpty}>{t("tableEdit.refTableNoMatch")}</li>
            ) : (
              candidates.map((it) => (
                <li key={it.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className={styles.refOption}
                    data-testid="fk-ref-option"
                    data-table-id={it.id}
                    // blur より先に拾う（onClick だと入力欄の blur で候補が消えてしまう）
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelect(it.id);
                    }}
                  >
                    <span className={styles.refOptionName}>
                      {label(it)}
                      {it.id === selfId ? ` (${t("tableEdit.selfRef")})` : ""}
                    </span>
                    {label(it) !== it.id && (
                      <span className={cx("mono", styles.refOptionId)}>{it.id}</span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}

// ------------------------------------------------------------------ 論理一意制約

export function LogicalUniqueDialog({
  table,
  initial,
  taken,
  onSubmit,
  onClose,
}: {
  table: Table;
  /** null = 新規追加 */
  initial: DraftLogicalUnique | null;
  /** ほかの論理一意制約の名前（重複させない・自動生成の連番に使う） */
  taken: ReadonlySet<string>;
  onSubmit: (next: DraftLogicalUnique) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  // 空の行（カラム未選択）も持てるようにするため、uid つきの行として扱う。
  // 新規追加は空の行を1つ置いて始める（いきなり [＋] を押させない）
  const [rows, setRows] = useState<{ uid: number; column: string }[]>(() => {
    const cols = initial?.columns ?? [];
    if (cols.length === 0) return [{ uid: newUid(), column: "" }];
    return cols.map((column) => ({ uid: newUid(), column }));
  });

  const columnNames = table.columns.map((c) => c.name);
  const columns = rows.map((r) => r.column);
  const autoName = generateConstraintName("luk", table.name, columns.filter((c) => c !== ""), taken);
  const duplicate = name.trim() !== "" && taken.has(name.trim());

  const blocked =
    rows.length === 0 || columns.some((c) => c === "")
      ? t("tableEdit.needColumns")
      : duplicate
        ? t("tableEdit.nameDuplicate")
        : null;

  return (
    <Dialog
      title={initial === null ? t("tableEdit.uniqueAddTitle") : t("tableEdit.uniqueEditTitle")}
      onClose={onClose}
    >
      <p className="muted form-hint">{t("tableEdit.uniqueDialogHint")}</p>
      <NameField
        value={name}
        autoName={autoName}
        duplicate={duplicate}
        onChange={setName}
        testId="constraint-name"
      />

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("tableEdit.uniqueColumns")}</span>
        <span className={styles.fieldHint}>{t("tableEdit.orderHint")}</span>
        <RowList addLabel={t("tableEdit.addColumnRow")} addTestId="add-column-row"
          onAdd={() => setRows((rs) => [...rs, { uid: newUid(), column: "" }])}
        >
          {rows.map((r, i) => (
            <div key={r.uid} className={styles.pairRow}>
              <span className={styles.pairIndex}>{i + 1}</span>
              <select
                className={cx("mono", styles.select)}
                data-testid={`unique-column-${i}`}
                value={r.column}
                onChange={(e) =>
                  setRows((rs) => rs.map((x) => (x.uid === r.uid ? { ...x, column: e.target.value } : x)))
                }
              >
                <option value="">{t("tableEdit.selectColumn")}</option>
                {columnNames
                  // 他の行で選ばれているカラムは出さない（同じカラムを2回は使えない）
                  .filter((c) => c === r.column || !columns.includes(c))
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className={styles.removeRow}
                aria-label={t("tableEdit.remove")}
                title={t("tableEdit.remove")}
                onClick={() => setRows((rs) => rs.filter((x) => x.uid !== r.uid))}
              >
                ×
              </button>
            </div>
          ))}
        </RowList>
      </div>

      <NotesField value={notes} onChange={setNotes} />
      <DialogActions
        blocked={blocked}
        editing={initial !== null}
        onClose={onClose}
        onSubmit={() =>
          onSubmit({
            uid: initial?.uid ?? newUid(),
            name: name.trim(),
            columns,
            notes: notes.trim(),
          })
        }
      />
    </Dialog>
  );
}

// ------------------------------------------------------------------ 論理外部制約

export function LogicalFkDialog({
  table,
  initial,
  adding = initial === null,
  taken,
  busy = false,
  error,
  extraActions,
  onSubmit,
  onClose,
}: {
  table: Table;
  /** null = 新規追加 */
  initial: DraftLogicalFk | null;
  /**
   * 新規追加として扱うか（既定は initial===null）。ER図から作るときは参照先が決まった状態で
   * 開くため、初期値を渡しつつ「追加」の見た目にする必要がある
   */
  adding?: boolean;
  /** ほかの論理外部制約の名前（重複させない・自動生成の連番に使う） */
  taken: ReadonlySet<string>;
  /** 保存中（ER図からの即時保存。押しっぱなしを防ぐ） */
  busy?: boolean;
  /** 保存に失敗した理由（ダイアログを閉じずに見せる） */
  error?: string | null;
  /** 追加のボタン（ER図からの編集では [削除] を置く） */
  extraActions?: React.ReactNode;
  onSubmit: (next: DraftLogicalFk) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [cardinality, setCardinality] = useState<DraftCardinality>(
    initial?.cardinality ?? { ...EMPTY_CARDINALITY },
  );
  const [refTable, setRefTable] = useState(initial?.refTable ?? "");
  // 既存データは両側の本数がずれている可能性がある（手書きのファイル）。長い方に合わせて
  // 組にし、欠けた側は未選択として見せる（ダイアログ上で必ず埋めさせる）
  const [pairs, setPairs] = useState<PairRow[]>(() => {
    const cols = initial?.columns ?? [];
    const refs = initial?.refColumns ?? [];
    const n = Math.max(cols.length, refs.length);
    if (n === 0) return [{ uid: newUid(), column: "", refColumn: "" }];
    return Array.from({ length: n }, (_, i) => ({
      uid: newUid(),
      column: cols[i] ?? "",
      refColumn: refs[i] ?? "",
    }));
  });

  const columnNames = table.columns.map((c) => c.name);
  // 参照先テーブルのスキーマはオンデマンドで読む（参照先カラムの選択肢に要る）
  const target = useAppStore((s) => (refTable !== "" ? s.tables[refTable] : undefined));
  useEffect(() => {
    if (refTable !== "" && refTable !== table.id) void loadTable(refTable);
  }, [refTable, table.id]);
  const refColumnNames =
    refTable === table.id ? columnNames : (target?.columns ?? []).map((c) => c.name);
  const refLoading = refTable !== "" && refTable !== table.id && target === undefined;

  const columns = pairs.map((p) => p.column);
  const refColumns = pairs.map((p) => p.refColumn);
  const autoName = generateConstraintName("lfk", table.name, columns.filter((c) => c !== ""), taken);
  const duplicate = name.trim() !== "" && taken.has(name.trim());

  const blocked =
    refTable === ""
      ? t("tableEdit.needRefTable")
      : pairs.length === 0 || columns.some((c) => c === "") || refColumns.some((c) => c === "")
        ? t("tableEdit.needPairs")
        : duplicate
          ? t("tableEdit.nameDuplicate")
          : null;

  const setPair = (uid: number, patch: Partial<PairRow>): void =>
    setPairs((ps) => ps.map((p) => (p.uid === uid ? { ...p, ...patch } : p)));

  return (
    <Dialog
      title={adding ? t("tableEdit.fkAddTitle") : t("tableEdit.fkEditTitle")}
      onClose={onClose}
    >
      <p className="muted form-hint">{t("tableEdit.fkDialogHint")}</p>
      <NameField
        value={name}
        autoName={autoName}
        duplicate={duplicate}
        onChange={setName}
        testId="constraint-name"
      />

      {/* 参照先が変わると参照先カラムは意味を失う（自カラム側の対応は残す） */}
      <RefTablePicker
        selfId={table.id}
        value={refTable}
        onSelect={(id) => {
          setRefTable(id);
          setPairs((ps) => ps.map((p) => ({ ...p, refColumn: "" })));
        }}
        onClear={() => {
          setRefTable("");
          setPairs((ps) => ps.map((p) => ({ ...p, refColumn: "" })));
        }}
      />

      {/* カラムの対応は1行 = 1組。複合キーでも縦に伸びるだけで、対応が読み取れる */}
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("tableEdit.columnMapping")}</span>
        <span className={styles.fieldHint}>{t("tableEdit.mappingHint")}</span>
        <div className={styles.pairHead}>
          <span className={styles.pairIndex} />
          <span className={styles.pairHeadCell}>{table.id}</span>
          <span className={styles.pairArrow} aria-hidden="true">
            →
          </span>
          <span className={styles.pairHeadCell}>
            {refTable === "" ? t("tableEdit.refTable") : refTable}
          </span>
          <span className={styles.removeRowSpacer} />
        </div>
        <RowList
          addLabel={t("tableEdit.addPair")}
          addTestId="add-pair-row"
          onAdd={() => setPairs((ps) => [...ps, { uid: newUid(), column: "", refColumn: "" }])}
        >
          {pairs.map((p, i) => (
            <div key={p.uid} className={styles.pairRow}>
              <span className={styles.pairIndex}>{i + 1}</span>
              <select
                className={cx("mono", styles.select)}
                data-testid={`fk-column-${i}`}
                value={p.column}
                onChange={(e) => setPair(p.uid, { column: e.target.value })}
              >
                <option value="">{t("tableEdit.selectColumn")}</option>
                {columnNames
                  .filter((c) => c === p.column || !columns.includes(c))
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </select>
              <span className={styles.pairArrow} aria-hidden="true">
                →
              </span>
              <select
                className={cx("mono", styles.select)}
                data-testid={`fk-ref-column-${i}`}
                value={p.refColumn}
                disabled={refTable === "" || refLoading}
                onChange={(e) => setPair(p.uid, { refColumn: e.target.value })}
              >
                <option value="">
                  {refLoading ? t("tableEdit.refLoading") : t("tableEdit.selectColumn")}
                </option>
                {refColumnNames
                  .filter((c) => c === p.refColumn || !refColumns.includes(c))
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className={styles.removeRow}
                aria-label={t("tableEdit.remove")}
                title={t("tableEdit.remove")}
                onClick={() => setPairs((ps) => ps.filter((x) => x.uid !== p.uid))}
              >
                ×
              </button>
            </div>
          ))}
        </RowList>
      </div>

      <NotesField value={notes} onChange={setNotes} />

      {/* カーディナリティはこの制約の属性なので、別枠の一覧ではなくここで設定する（P-11） */}
      <CardinalityFields
        value={cardinality}
        // 解決値は保存済みの名前でしか引けない（新規・リネーム中は出ない）
        relationId={
          initial !== null && !adding && initial.name.trim() !== ""
            ? `${table.id}#lfk:${initial.name.trim()}`
            : null
        }
        onChange={setCardinality}
      />

      <DialogActions
        blocked={blocked}
        editing={!adding}
        busy={busy}
        error={error}
        extraActions={extraActions}
        onClose={onClose}
        onSubmit={() =>
          onSubmit({
            uid: initial?.uid ?? newUid(),
            name: name.trim(),
            columns,
            refTable,
            refColumns,
            notes: notes.trim(),
            cardinality,
          })
        }
      />
    </Dialog>
  );
}

// ------------------------------------------------------------------ 物理外部キー

/**
 * 物理FK の詳細（O-03 / P-11）。**定義そのものは machine-owned で編集できない**
 * （DB から読み取った内容であり、変更は逆生成の適用でのみ入る。J-01〜J-04）。
 * ここで編集できるのは人が付ける情報 = カーディナリティの上書きと注記だけ。
 */
export function PhysicalFkDialog({
  table,
  fk,
  initial,
  busy = false,
  error,
  onSubmit,
  onClose,
}: {
  table: Table;
  fk: ForeignKey;
  initial: DraftCardinality;
  busy?: boolean;
  error?: string | null;
  onSubmit: (next: DraftCardinality) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [cardinality, setCardinality] = useState<DraftCardinality>(initial);
  const n = Math.max(fk.columns.length, fk.ref.columns?.length ?? 0);

  return (
    <Dialog title={t("tableEdit.physicalFkTitle")} onClose={onClose}>
      <p className="muted form-hint">{t("tableEdit.physicalFkHint")}</p>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("relation.name")}</span>
        <span className={cx("mono", styles.readonlyValue)} data-testid="physical-fk-name">
          {fk.name ?? t("constraint.noName")}
        </span>
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("tableEdit.columnMapping")}</span>
        <div className={cx("mono", styles.readonlyValue)}>
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className={styles.detailPair}>
              <span>{fk.columns[i] ?? "?"}</span>
              <span className={styles.pairArrow} aria-hidden="true">
                →
              </span>
              <span>{`${fk.ref.table}.${fk.ref.columns?.[i] ?? "?"}`}</span>
            </div>
          ))}
        </div>
      </div>

      {(fk.onDelete !== undefined || fk.onUpdate !== undefined) && (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t("tableEdit.fkActions")}</span>
          <span className={cx("mono", styles.readonlyValue)}>
            {[
              fk.onDelete !== undefined ? `ON DELETE ${fk.onDelete}` : null,
              fk.onUpdate !== undefined ? `ON UPDATE ${fk.onUpdate}` : null,
            ]
              .filter((s) => s !== null)
              .join(" / ")}
          </span>
        </div>
      )}

      <CardinalityFields
        value={cardinality}
        relationId={fk.name === undefined ? null : `${table.id}#fk:${fk.name}`}
        onChange={setCardinality}
      />

      <DialogActions
        blocked={null}
        editing
        busy={busy}
        error={error}
        onClose={onClose}
        onSubmit={() => onSubmit(cardinality)}
      />
    </Dialog>
  );
}
