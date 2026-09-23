/**
 * テーブル詳細の共通表示（G-01〜G-05 / O-02 で共用）。
 * メタデータ表・カラム表・制約表（被参照を含む）・配置ページを表示する。
 * サーバーモード（canEdit）では、テーブル・カラムの論理情報（論理名・タグ・色・注記）を
 * ペンから開くダイアログでその場編集できる（R-05）。物理情報は常に閲覧専用。
 *
 * メタデータ（物理名・種別・コメント・タグ・注記）は {@link TableMetaTable} の
 * 「項目名と値」の表に、制約（主キー・ユニーク・インデックス・外部キー・論理制約）と被参照は
 * {@link ConstraintTable} の1つの表にまとめる。どちらも詳細とドキュメント（R-01）で共用する。
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";
import { colorAttr, isColorToken } from "../model/colors";
import { loadTable } from "../model/loader";
import {
  formatName,
  resolveColumnColor,
  resolveColumnName,
  resolveColumnTags,
  resolveTableName,
} from "../model/logicalName";
import type { MetaField, MetaTarget } from "../model/metaTarget";
import { useAppStore, type ConstraintKind } from "../model/store";
import { isTableKind, parseEdgeId, type Relation, type Table } from "../model/types";
import { cx } from "../lib/cx";
import { hrefs } from "./router";
import { PenIcon } from "./icons";
import { Link } from "./Link";
import { NotePopover } from "./NotePopover";
import { ScrollTable } from "./ScrollTable";
import styles from "./TableInfo.module.scss";

/**
 * ペンの data-testid の後半（`<前半>-name` のように項目で分ける）。
 * どの項目のペンを押したのかを e2e から指せるようにするため
 */
const FIELD_TEST_ID: Record<MetaField, string> = {
  displayName: "name",
  tags: "tags",
  color: "color",
  notes: "notes",
};

/** 参照先テーブルへのリンク（存在しなければ物理名のみ） */
export function TableLink({ tableId, onNavigate }: { tableId: string; onNavigate?: () => void }) {
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const it = index?.tables?.find((x) => x.id === tableId);
  if (!it) return <span className={styles.tableLinkMissing}>{tableId}</span>;
  const label = formatName(resolveTableName(it.name, it.displayName), it.name, nameDisplay);
  return (
    <Link href={hrefs.table(tableId)} onClick={onNavigate}>
      {label}
    </Link>
  );
}

interface TableInfoProps {
  tableId: string;
  /** ダイアログから開いたとき、リンククリックでダイアログを閉じる */
  onNavigate?: () => void;
  /**
   * カラム表の高さを制限しない（テーブル画面の連続表示。R-01）。
   * 既定ではダイアログ・単体表示向けに表だけをスクロールさせる
   */
  fullHeight?: boolean;
  /**
   * 論理情報（論理名・タグ・色・注記）のペンを出す（R-05。サーバーモードのとき）。
   * 押されたら論理情報ダイアログ（MetaEditDialog）をダイアログの積み重ねに載せる。
   * 省略時は閲覧専用（静的モード）
   */
  canEdit?: boolean;
}

/**
 * 編集のペン（詳細・ドキュメントで共通の見た目。虫眼鏡と同じ体裁）。
 * hover=true なら、**置かれたセル**（`.editable`）にホバーしたときだけ見せる
 * （DOM には残す = キーボードで届く）。編集できる項目ごとに並ぶため、
 * 常に見せると表がペンだらけになる
 */
export function EditPen({
  label,
  testId,
  className,
  hover = false,
  onClick,
}: {
  label: string;
  testId?: string;
  className?: string;
  hover?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cx(styles.detailButton, hover && styles.hoverPen, className)}
      data-testid={testId}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <PenIcon size={14} strokeWidth={2} />
    </button>
  );
}

/**
 * 論理情報の値。編集できるとき（onEdit あり）は**本文の末尾にペンを続ける**
 * （置かれたセルにホバーしたときだけ見える。`.editable` が掛かり先）。
 *
 * ペンを項目ごとに置くのは、行末の1つのペンだと「この行のどれを直すのか」が
 * ダイアログを開くまで分からないため。開いた先も押した項目に初期フォーカスする（R-05）。
 * 値が空のときに何を置くか（「（未設定）」/ 何も置かない）は、行かセルかで違うので呼び出し側が決める。
 */
export function EditableValue({
  field,
  label,
  testId,
  onEdit,
  children,
}: {
  field: MetaField;
  /** ペンのラベルに入れる項目名（「論理名を編集」） */
  label: string;
  /** ペンの data-testid（項目名を後ろに付ける） */
  testId?: string;
  onEdit?: (field: MetaField) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  if (onEdit === undefined) return <>{children}</>;
  return (
    <>
      {children}
      <EditPen
        label={t("doc.editMetaField", { name: label })}
        testId={testId}
        hover
        onClick={() => onEdit(field)}
      />
    </>
  );
}

/** 論理情報が未設定であることを薄く示す（ペンの掛かり先。値のある行と同じ位置に置く） */
export function NotSet() {
  const { t } = useI18n();
  return <span className="muted">（{t("table.notSet")}）</span>;
}

/** メタデータ表の1行（値が無い項目は呼び出し側が出さない） */
function MetaRow({
  label,
  valueTestId,
  className,
  editable = false,
  children,
}: {
  label: string;
  valueTestId?: string;
  className?: string;
  /** 値のセルにペンが載る（ホバーで出す。CSS の掛かり先） */
  editable?: boolean;
  children: ReactNode;
}) {
  return (
    <tr className={className}>
      <th scope="row" className={styles.metaKey}>
        {label}
      </th>
      <td className={cx(editable && styles.editable)} data-testid={valueTestId}>
        {children}
      </td>
    </tr>
  );
}

/**
 * テーブルのメタデータ（物理名・種別・DB コメント・タグ・注記）を
 * 「項目名と値」の表にまとめたもの。詳細とドキュメント（R-01）で共用する。
 *
 * 項目ごとに段落を積むのをやめ、1つの表に集約した（項目が増えるたびに見た目の決めごとが
 * 増えるのを避ける。値の無い項目は行ごと出さない）。
 * 項目名は各行の先頭にあるので、列見出し（thead）は出さない。
 *
 * 編集できるとき（onEdit あり）は**論理情報の項目（論理名・タグ・色・注記）を必ず行として出し**、
 * 値のセルにホバーでペンを出す。未設定の項目も行が無いと直しようがないため、
 * 「（未設定）」を薄く置いて掛かり先にする。
 *
 * @param onEdit 渡すと論理情報の各行にペンを出す（押された項目をダイアログへ渡す）
 * @param editTestId ペンの data-testid の前半（後半は項目名。`…-name` / `-tags` / `-color` / `-notes`）
 * @param showEmpty 論理情報の項目を値が無くても出す（編集できるときは常に true で呼ぶ）
 */
export function TableMetaTable({
  table,
  onEdit,
  editTestId,
  showEmpty = false,
}: {
  table: Table;
  onEdit?: (field: MetaField) => void;
  editTestId?: string;
  showEmpty?: boolean;
}) {
  const { t } = useI18n();
  const displayName = table.meta?.displayName ?? "";
  const notes = table.meta?.notes ?? "";
  const tags = table.meta?.tags ?? [];
  const color = table.meta?.color ?? "";
  const comment = table.comment ?? "";
  const editable = onEdit !== undefined;
  /** 論理情報の行。値が空でも、編集できるなら行ごと出す（ペンの居場所） */
  const showField = (empty: boolean): boolean => !empty || showEmpty;
  const testIdOf = (field: MetaField): string | undefined =>
    editTestId === undefined ? undefined : `${editTestId}-${FIELD_TEST_ID[field]}`;
  return (
    <ScrollTable testId="table-meta" tableClassName={styles.metaTable}>
      <MetaRow label={t("table.metaId")}>
        <span className="mono">{table.id}</span>
      </MetaRow>
      {/* ビュー等の種別バッジ（O-10）。DB が返した原文をそのまま出すため翻訳しない */}
      {!isTableKind(table.kind) && (
        <MetaRow label={t("table.objectKind")} valueTestId="object-kind">
          <span className={styles.objectKindBadge}>{table.kind}</span>
        </MetaRow>
      )}
      {comment !== "" && <MetaRow label={t("table.colComment")}>{comment}</MetaRow>}
      {showField(displayName === "") && (
        <MetaRow label={t("doc.logicalName")} editable={editable}>
          <EditableValue
            field="displayName"
            label={t("doc.logicalName")}
            testId={testIdOf("displayName")}
            onEdit={onEdit}
          >
            {displayName !== "" ? (
              <span data-testid="table-display-name">{displayName}</span>
            ) : (
              <NotSet />
            )}
          </EditableValue>
        </MetaRow>
      )}
      {showField(tags.length === 0) && (
        <MetaRow label={t("table.tags")} editable={editable}>
          <EditableValue
            field="tags"
            label={t("table.tags")}
            testId={testIdOf("tags")}
            onEdit={onEdit}
          >
            {tags.length > 0 ? (
              <span className={styles.columnTags}>
                {tags.map((tag) => (
                  <span key={tag} className={styles.tag}>
                    {tag}
                  </span>
                ))}
              </span>
            ) : (
              <NotSet />
            )}
          </EditableValue>
        </MetaRow>
      )}
      {showField(!isColorToken(color)) && (
        <MetaRow label={t("tableEdit.color")} editable={editable}>
          <EditableValue
            field="color"
            label={t("tableEdit.color")}
            testId={testIdOf("color")}
            onEdit={onEdit}
          >
            {isColorToken(color) ? (
              <span className={styles.colorValue}>
                <span className={styles.colorChip} data-color={colorAttr(color)} />
                {t(`color.${color}` as const)}
              </span>
            ) : (
              <NotSet />
            )}
          </EditableValue>
        </MetaRow>
      )}
      {showField(notes === "") && (
        // 注記は人が改行を入れて書くので、本文はそのまま流してペンを末尾に続ける
        <MetaRow
          label={t("table.notes")}
          className={cx("table-notes", styles.tableNotes)}
          editable={editable}
        >
          <EditableValue
            field="notes"
            label={t("table.notes")}
            testId={testIdOf("notes")}
            onEdit={onEdit}
          >
            {notes !== "" ? (
              <span className={styles.tableNotesText} data-testid="table-notes-text">
                {notes}
              </span>
            ) : (
              <span className={styles.tableNotesEmpty}>{t("doc.noNotes")}</span>
            )}
          </EditableValue>
        </MetaRow>
      )}
    </ScrollTable>
  );
}

export function TableInfo({ tableId, onNavigate, fullHeight = false, canEdit = false }: TableInfoProps) {
  const { t } = useI18n();
  const openDialog = useAppStore((s) => s.openDialog);
  const table = useAppStore((s) => s.tables[tableId]);
  const error = useAppStore((s) => s.tableErrors[tableId]);
  const dictionary = useAppStore((s) => s.dictionary);
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);

  useEffect(() => {
    void loadTable(tableId);
  }, [tableId]);

  const indexEntry = index?.tables?.find((x) => x.id === tableId);

  if (error !== undefined) {
    return <p className="error-text">{t("table.loadError", { error })}</p>;
  }
  if (!table) {
    if (!indexEntry && index !== null) {
      return <p className="error-text">{t("table.notFound", { id: tableId })}</p>;
    }
    return <p className="muted">{t("table.loading")}</p>;
  }

  const pk = new Set(table.primaryKey ?? []);
  const fkCols = new Set((table.foreignKeys ?? []).flatMap((fk) => fk.columns));

  // 論理情報の編集はダイアログの積み重ねに載せる（ER図のテーブル詳細ダイアログの上にも重なる）。
  // 押されたペンの項目（field）を渡し、ダイアログでその入力欄へ初期フォーカスする
  const editMeta = (target: MetaTarget, field: MetaField): void =>
    openDialog({ type: "meta", target, field });
  /** カラム行のペン（閲覧専用なら undefined = ペンを出さない） */
  const columnEdit = (column: string): ((field: MetaField) => void) | undefined =>
    canEdit ? (field) => editMeta({ kind: "column", tableId: table.id, column }, field) : undefined;

  return (
    <div className={styles.tableInfo}>
      <h3>{t("table.metadata")}</h3>
      <TableMetaTable
        table={table}
        showEmpty={canEdit}
        onEdit={
          canEdit ? (field) => editMeta({ kind: "table", tableId: table.id }, field) : undefined
        }
        editTestId={`table-meta-edit-${table.id}`}
      />

      <h3>{t("table.columns")}</h3>
      {/* カラム数が多いテーブルでページが縦に伸びきらないよう、表だけを（ヘッダを固定して）
          スクロールさせる。仮想化はしない（カラム辞書と違って行の高さが揃わないため） */}
      <ScrollTable
        className={fullHeight ? undefined : styles.columnsScroll}
        testId="table-columns"
        head={
          <tr>
            <th>{t("table.colPk")}</th>
            <th>{t("table.colName")}</th>
            <th>{t("table.colLogicalName")}</th>
            <th>{t("table.colType")}</th>
            <th>{t("table.colNullable")}</th>
            <th>{t("table.colDefault")}</th>
            <th>{t("table.colComment")}</th>
            <th>{t("table.tags")}</th>
            <th className={styles.notesCell}>{t("table.colNotes")}</th>
          </tr>
        }
      >
        {table.columns.map((c) => {
          const logical = resolveColumnName(table, c.name, dictionary);
          const meta = table.meta?.columns?.[c.name];
          // 色は個別 → 辞書、タグは辞書 ∪ 個別。表示では出どころを区別しない（P-12 / P-13）
          const color = resolveColumnColor(table, c.name, dictionary).color;
          const tags = resolveColumnTags(table, c.name, dictionary).tags;
          return (
            <tr key={c.name} className={styles.columnRow} data-color={colorAttr(color)}>
              <td className="center">
                {pk.has(c.name) && <span className={cx(styles.keyBadge, styles.keyPk)}>PK</span>}
                {fkCols.has(c.name) && <span className={cx(styles.keyBadge, styles.keyFk)}>FK</span>}
              </td>
              <td className="mono">{c.name}</td>
              {/* 論理名・タグ・注記は行の中で直せる。ペンはそのセルにホバーしたときだけ出す */}
              <td className={cx(canEdit && styles.editable)}>
                <EditableValue
                  field="displayName"
                  label={t("table.colLogicalName")}
                  testId={`column-meta-edit-${c.name}-name`}
                  onEdit={columnEdit(c.name)}
                >
                  {logical.source === "physical" ? (
                    <NotSet />
                  ) : (
                    <>
                      {logical.name}
                      {logical.source === "dictionary" && <span className="badge badge-dict">辞書</span>}
                    </>
                  )}
                </EditableValue>
              </td>
              <td className="mono">
                {c.type ?? c.logicalType ?? ""}
                {c.autoIncrement === true && <span className="badge">{t("table.autoIncrement")}</span>}
                {c.generated === true && <span className="badge">{t("table.generated")}</span>}
              </td>
              <td className="center">{c.nullable === true ? t("common.yes") : t("common.no")}</td>
              <td className="mono">{c.default !== undefined ? String(c.default) : ""}</td>
              <td>{c.comment ?? ""}</td>
              <td className={cx(canEdit && styles.editable)}>
                <EditableValue
                  field="tags"
                  label={t("table.tags")}
                  testId={`column-meta-edit-${c.name}-tags`}
                  onEdit={columnEdit(c.name)}
                >
                  {/* 行では空を「未設定」と書かない（毎行に並ぶと読みの邪魔になる）。
                      セルは残るのでホバーでペンには届く */}
                  {tags.length > 0 && (
                    <span className={styles.columnTags}>
                      {tags.map((tag) => (
                        <span key={tag} className={styles.tag}>
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </EditableValue>
              </td>
              {/* 注記は本文を並べると行の高さがばらつくので、印だけ出してポップアップ
                  （ホバー）とダイアログ（クリック）で読ませる */}
              <td className={cx("center", styles.notesCell, canEdit && styles.editable)}>
                <EditableValue
                  field="notes"
                  label={t("table.colNotes")}
                  testId={`column-meta-edit-${c.name}-notes`}
                  onEdit={columnEdit(c.name)}
                >
                  <NotePopover
                    text={meta?.notes ?? ""}
                    testId={`column-notes-${c.name}`}
                    dialogTitle={
                      <>
                        {t("table.colNotes")}: <span className="mono">{c.name}</span>
                      </>
                    }
                  />
                </EditableValue>
              </td>
            </tr>
          );
        })}
      </ScrollTable>

      <h3>{t("table.constraints")}</h3>
      <ConstraintTable table={table} mode="detail" onNavigate={onNavigate} />

      <PagesSection tableId={table.id} onNavigate={onNavigate} />

      {/* ビュー等の定義 SQL（K-18 / O-11）。行の配列で持っているので改行で繋ぎ直す */}
      {(table.definition?.length ?? 0) > 0 && (
        <>
          <h3>{t("table.definition")}</h3>
          <pre className={styles.definitionPre} data-testid="view-definition">
            {table.definition?.join("\n")}
          </pre>
        </>
      )}

      {table.dialect !== undefined && Object.keys(table.dialect).length > 0 && (
        <>
          <h3>{t("table.dialect")}</h3>
          <pre className={styles.dialectPre}>{JSON.stringify(table.dialect, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 制約・被参照の表

/** 制約表の行の種別。`data-kind` に出して、見た目と e2e の指し先を種類ごとに分ける */
type ConstraintRowKind =
  | "pk"
  | "unique"
  | "index"
  | "fk"
  | "logicalUnique"
  | "logicalFk"
  | "referencedBy";

interface ConstraintRow {
  key: string;
  kind: ConstraintRowKind;
  label: string;
  /** 論理（ER図の破線と同じ意味づけ）。種別バッジの色で示す */
  logical: boolean;
  /** 相手テーブル（外部キー・論理外部制約・被参照だけ持つ） */
  refTable?: string;
  /** 対応カラム（詳細モードで出す） */
  columns: string;
  /** 注記（ドキュメントモードで出す）。物理の主キー・ユニーク・インデックスは持たない */
  notes: string;
  /** 種別に付く補足バッジ（インデックスの unique 指定） */
  badge?: string;
  /** 詳細を開く虫眼鏡 */
  detail: ReactNode;
}

/**
 * 制約（主キー・ユニーク・インデックス・外部キー・論理一意制約・論理外部制約）と被参照を
 * 1つの表にまとめたもの。詳細とドキュメント（R-01）で共用する。
 *
 * 種類ごとに見出しを立てて並べていたが、テーブルを読むときに知りたいのは
 * 「このテーブルにどんな決まりがあるか」であって種類の区切りではないため、
 * 種別を1列にして1つの表に集約した。細部（制約名・カーディナリティ・ON DELETE …）は
 * どの行からも虫眼鏡で同じ詳細ダイアログに寄せる。
 *
 * 列は **種別と説明の2列だけ**で、列見出し（thead）は出さない。説明は種別ごとに中身が
 * 違うため形を決めない（相手テーブルの無い制約に空の列を作らない）。虫眼鏡は**その行の本文の末尾**に
 * 続け、ホバーしたときだけ見せる。モードで入れ替えるのは説明の中身で、枠組みは変えない:
 * - `detail`: 相手テーブル + 対応カラム（注記は虫眼鏡の中で読む）
 * - `doc`: 相手テーブル + 対応カラム + 注記。ただし**外部キー・論理外部制約だけは対応カラムを
 *   落とす**（`col → refCol` の対応は相手テーブル名と注記の間に挟まると読みの邪魔になる。
 *   知りたいのは「どこを参照しているか」と「なぜそうしたか」で、どのカラムかは虫眼鏡の中で足りる）。
 *   ほかの種別は注記を持たないか短いので、構成カラムを出したほうが行が読める
 */
export function ConstraintTable({
  table,
  mode,
  onNavigate,
}: {
  table: Table;
  mode: "detail" | "doc";
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const tableId = table.id;

  // 被参照（G-02）: index.relations から to === 自分 を拾う（物理・論理とも）
  const referencedBy = useMemo(
    () => (index?.relations ?? []).filter((r) => r.to === tableId && r.from !== tableId),
    [index, tableId],
  );

  const rows: ConstraintRow[] = [];
  if ((table.primaryKey?.length ?? 0) > 0) {
    rows.push({
      key: "pk",
      kind: "pk",
      label: t("table.primaryKey"),
      logical: false,
      columns: (table.primaryKey ?? []).join(", "),
      notes: "",
      detail: <ConstraintDetailButton tableId={tableId} kind="primaryKey" at={0} />,
    });
  }
  table.uniques?.forEach((u, i) => {
    rows.push({
      key: `unique-${u.name ?? i}`,
      kind: "unique",
      label: t("table.uniques"),
      logical: false,
      columns: u.columns.join(", "),
      notes: "",
      detail: <ConstraintDetailButton tableId={tableId} kind="unique" at={i} />,
    });
  });
  table.indexes?.forEach((ix, i) => {
    rows.push({
      key: `index-${ix.name ?? i}`,
      kind: "index",
      label: t("table.indexes"),
      logical: false,
      columns: ix.columns.join(", "),
      notes: "",
      badge: ix.unique === true ? "unique" : undefined,
      detail: <ConstraintDetailButton tableId={tableId} kind="index" at={i} />,
    });
  });
  table.foreignKeys?.forEach((fk, i) => {
    rows.push({
      key: `fk-${fk.name ?? i}`,
      kind: "fk",
      label: t("table.foreignKeys"),
      logical: false,
      refTable: fk.ref.table,
      columns: pairsText(fk.columns, fk.ref.columns),
      // 物理FK 自身は注記を持たない。書けるのは多重度の補足（meta.relations）だけ
      notes: table.meta?.relations?.[`fk:${fk.name ?? ""}`]?.notes ?? "",
      detail: <RelationDetailButton relationId={edgeIdOf(tableId, "fk", fk.name)} />,
    });
  });
  table.meta?.logicalUniques?.forEach((u, i) => {
    rows.push({
      key: `lunique-${u.name ?? i}`,
      kind: "logicalUnique",
      label: t("table.logicalUniques"),
      logical: true,
      columns: u.columns.join(", "),
      notes: u.notes ?? "",
      detail: <ConstraintDetailButton tableId={tableId} kind="logicalUnique" at={i} />,
    });
  });
  table.meta?.logicalForeignKeys?.forEach((fk, i) => {
    rows.push({
      key: `lfk-${fk.name ?? i}`,
      kind: "logicalFk",
      label: t("table.logicalForeignKeys"),
      logical: true,
      refTable: fk.ref.table,
      columns: pairsText(fk.columns, fk.ref.columns),
      notes: fk.notes ?? "",
      detail: <RelationDetailButton relationId={edgeIdOf(tableId, "lfk", fk.name)} />,
    });
  });
  for (const r of referencedBy) {
    rows.push({
      key: `ref-${r.id}`,
      kind: "referencedBy",
      label: t("table.refBadge"),
      logical: r.kind === "logical" || parseEdgeId(r.id)?.kind === "lfk",
      refTable: r.from,
      columns: (r.columns ?? []).map(([from, to]) => `${from} → ${to}`).join(", "),
      // 注記は参照元テーブルの meta にあり、ここでは読み込んでいない（虫眼鏡の詳細で読む）
      notes: "",
      detail: <RelationDetailButton relationId={r.id} />,
    });
  }

  if (rows.length === 0) {
    return <p className="muted">{t("table.noConstraints")}</p>;
  }

  return (
    <ScrollTable testId="constraint-table">
      {rows.map((row) => {
        // ドキュメントでは外部キー・論理外部制約だけ対応カラムを落とし、その場所を注記に譲る
        const showColumns =
          row.columns !== "" && (mode === "detail" || (row.kind !== "fk" && row.kind !== "logicalFk"));
        return (
          <tr key={row.key} className={styles.constraintRow} data-testid="constraint-row" data-kind={row.kind}>
            <td className={styles.constraintKindCell}>
              <span className={cx("badge", row.logical ? "badge-logical" : "badge-physical")}>
                {row.label}
              </span>
              {row.badge !== undefined && <span className="badge">{row.badge}</span>}
            </td>
            {/* 説明。中身は種別とモードで変わり、虫眼鏡はその末尾に続く（行にホバーで出す） */}
            <td>
              <span className={styles.constraintDesc}>
                {row.refTable !== undefined && (
                  <TableLink tableId={row.refTable} onNavigate={onNavigate} />
                )}
                {showColumns &&
                  // 相手テーブルに続くときだけ括弧で括る（単体なら構成カラムそのもの）
                  (row.refTable !== undefined ? (
                    <span className="mono muted">({row.columns})</span>
                  ) : (
                    <span className="mono">{row.columns}</span>
                  ))}
                {mode === "doc" && row.notes !== "" && (
                  <span className={styles.constraintNotes}>{row.notes}</span>
                )}
                <span className={styles.constraintDetail}>{row.detail}</span>
              </span>
            </td>
          </tr>
        );
      })}
    </ScrollTable>
  );
}

/** 「(自カラム → 相手カラム, …)」。被参照の表示と同じ読み方に揃える */
function pairsText(columns: string[], refColumns: string[] | undefined): string {
  return columns.map((c, i) => `${c} → ${refColumns?.[i] ?? "?"}`).join(", ");
}

/** 制約からエッジID（`<テーブルID>#<種別>:<制約名>`）を作る。名前が無ければリレーションを引けない */
function edgeIdOf(tableId: string, kind: "fk" | "lfk", name: string | undefined): string | null {
  return name === undefined ? null : `${tableId}#${kind}:${name}`;
}

/**
 * リレーション詳細（E-10 のダイアログ）を開く虫眼鏡。参照・被参照のどちらからも同じものを開く。
 * index.relations に無いもの（名前の無い制約など）には出さない（開いても「存在しません」になるため）。
 */
function RelationDetailButton({ relationId }: { relationId: string | null }) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const openDialog = useAppStore((s) => s.openDialog);
  const exists =
    relationId !== null && (index?.relations ?? []).some((r) => r.id === relationId);
  if (!exists || relationId === null) return null;
  return (
    <DetailButton
      label={t("relation.title")}
      testId="relation-detail"
      onClick={() => openDialog({ type: "relation", id: relationId })}
    />
  );
}

/** ユニーク制約・インデックス・論理一意制約の詳細を開く虫眼鏡（リレーションと同じ導線） */
function ConstraintDetailButton({
  tableId,
  kind,
  at,
}: {
  tableId: string;
  kind: ConstraintKind;
  at: number;
}) {
  const { t } = useI18n();
  const openDialog = useAppStore((s) => s.openDialog);
  return (
    <DetailButton
      label={t("constraint.title")}
      testId="constraint-detail"
      onClick={() => openDialog({ type: "constraint", tableId, kind, at })}
    />
  );
}

/**
 * 一覧行の虫眼鏡。制約の種類によらず同じ見た目・同じ位置にする。
 * 行にホバー（またはキーボードでフォーカス）したときだけ見せる — 論理情報のペンと同じ扱いで、
 * 常に出していると、制約が並んだときに虫眼鏡の列が本文より目立ってしまう
 */
function DetailButton({
  label,
  testId,
  onClick,
}: {
  label: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cx(styles.detailButton, styles.hoverPen)}
      data-testid={testId}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <SearchIcon />
    </button>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </svg>
  );
}

export function RelationKindBadge({ relation }: { relation: Relation }) {
  const { t } = useI18n();
  const parts = parseEdgeId(relation.id);
  const logical = relation.kind === "logical" || parts?.kind === "lfk";
  return (
    <span className={"badge " + (logical ? "badge-logical" : "badge-physical")}>
      {logical ? t("relation.kindLogical") : t("relation.kindPhysical")}
    </span>
  );
}

/**
 * 所属ページ一覧（G-05 / O-04）。未配置なら明示する。詳細とドキュメント（R-01）で共用する。
 *
 * @param headingClassName 見出しの追加クラス（TableInfo の外に置くドキュメントが渡す）
 */
export function PagesSection({
  tableId,
  onNavigate,
  headingClassName,
}: {
  tableId: string;
  onNavigate?: () => void;
  headingClassName?: string;
}) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const manifest = useAppStore((s) => s.manifest);
  const entry = index?.tables?.find((x) => x.id === tableId);
  const diagramIds = entry?.diagrams ?? [];
  return (
    <>
      <h3 className={headingClassName}>{t("table.pages")}</h3>
      {diagramIds.length === 0 ? (
        <p className="muted">{t("table.unplacedNote")}</p>
      ) : (
        // 「1件 = 1枠」で横に並べる
        <ul className={styles.itemList} data-testid="page-list">
          {diagramIds.map((id) => {
            const ref = manifest?.diagrams?.find((d) => d.id === id);
            return (
              <li key={id} className={styles.item}>
                <Link href={hrefs.erd(id, tableId)} onClick={onNavigate}>
                  {ref?.title ?? id}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
