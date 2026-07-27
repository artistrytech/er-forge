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
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { loadTable } from "../model/loader";
import {
  generateConstraintName,
  newUid,
  type DraftLogicalFk,
  type DraftLogicalUnique,
} from "../model/metaDraft";
import { formatName, resolveIndexTableName } from "../model/logicalName";
import { useAppStore } from "../model/store";
import type { IndexTable, Table } from "../model/types";
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
  autoName,
  detail,
  notes,
  hasError,
  testId,
  onEdit,
  onRemove,
}: {
  name: string;
  /** 名前が空のときに保存で付く名前（プレビュー） */
  autoName: string;
  detail: React.ReactNode;
  notes: string;
  hasError: boolean;
  testId: string;
  onEdit: () => void;
  onRemove: () => void;
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
          {hasError && <span className="field-error">⚠</span>}
        </div>
        <div className={cx("mono", styles.rowDetail)}>{detail}</div>
        {notes.trim() !== "" && <div className={styles.rowNotes}>{notes}</div>}
      </div>
      <div className={styles.rowActions}>
        <Button data-testid={`${testId}-edit`} onClick={onEdit}>
          {t("tableEdit.edit")}
        </Button>
        <Button variant="danger" data-testid={`${testId}-remove`} onClick={onRemove}>
          {t("tableEdit.remove")}
        </Button>
      </div>
    </li>
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

/** [確定]（確定できないときは理由を出したまま押させない）＋ [キャンセル] */
function DialogActions({
  blocked,
  editing,
  onSubmit,
  onClose,
}: {
  /** 確定できない理由（null なら確定できる） */
  blocked: string | null;
  editing: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {blocked !== null && <p className={styles.blockedHint}>{blocked}</p>}
      <div className="dialog-actions">
        <Button
          variant="primary"
          data-testid="constraint-submit"
          disabled={blocked !== null}
          onClick={onSubmit}
        >
          {editing ? t("tableEdit.applyEdit") : t("tableEdit.applyAdd")}
        </Button>
        <Button onClick={onClose}>{t("layout.cancel")}</Button>
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
  taken,
  onSubmit,
  onClose,
}: {
  table: Table;
  /** null = 新規追加 */
  initial: DraftLogicalFk | null;
  /** ほかの論理外部制約の名前（重複させない・自動生成の連番に使う） */
  taken: ReadonlySet<string>;
  onSubmit: (next: DraftLogicalFk) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const [name, setName] = useState(initial?.name ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [refTable, setRefTable] = useState(initial?.refTable ?? "");
  const [filter, setFilter] = useState("");
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
  const tableLabel = (it: IndexTable): string =>
    formatName(resolveIndexTableName(it), it.name, nameDisplay);
  // 名称（論理名・物理名・ID）での絞り込み。選択中のものは常に残す
  const refCandidates = (index?.tables ?? []).filter((it) => {
    const q = filter.trim().toLowerCase();
    if (q === "" || it.id === refTable) return true;
    return (
      it.id.toLowerCase().includes(q) ||
      it.name.toLowerCase().includes(q) ||
      resolveIndexTableName(it).name.toLowerCase().includes(q)
    );
  });
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
      title={initial === null ? t("tableEdit.fkAddTitle") : t("tableEdit.fkEditTitle")}
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

      <div className={styles.field}>
        <span className={styles.fieldLabel}>
          {t("tableEdit.refTable")}
          <span className={styles.fieldCount}>{t("catalog.count", { n: refCandidates.length })}</span>
        </span>
        {/* テーブルが増えると選択肢が長くなるため、名称（論理名・物理名）で絞れるようにする。
            候補は畳まない一覧で出す（畳んだままだと、絞り込んだ結果が開くまで見えない）。
            選択済みのテーブルは絞り込みから外れても候補に残す（選択が消えないように） */}
        <input
          type="search"
          className={styles.input}
          data-testid="fk-ref-filter"
          placeholder={t("tableEdit.refTableFilter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className={cx(styles.select, styles.selectWide, styles.refList)}
          data-testid="fk-ref-table"
          size={6}
          value={refTable}
          // 参照先が変わると参照先カラムは意味を失う（自カラム側の対応は残す）
          onChange={(e) => {
            setRefTable(e.target.value);
            setPairs((ps) => ps.map((p) => ({ ...p, refColumn: "" })));
          }}
        >
          {refCandidates.map((it) => (
            <option key={it.id} value={it.id}>
              {tableLabel(it)}
              {it.id === table.id ? ` (${t("tableEdit.selfRef")})` : ""}
            </option>
          ))}
        </select>
        {refCandidates.length === 0 && (
          <span className={styles.fieldHint}>{t("tableEdit.refTableNoMatch")}</span>
        )}
      </div>

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
      <DialogActions
        blocked={blocked}
        editing={initial !== null}
        onClose={onClose}
        onSubmit={() =>
          onSubmit({
            uid: initial?.uid ?? newUid(),
            name: name.trim(),
            columns,
            refTable,
            refColumns,
            notes: notes.trim(),
          })
        }
      />
    </Dialog>
  );
}
