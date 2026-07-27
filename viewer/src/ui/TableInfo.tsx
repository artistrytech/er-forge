/**
 * テーブル詳細の共通表示（G-01〜G-05 / O-02 で共用）。
 * カラム表・制約・論理制約・被参照一覧・meta・配置ページを表示する。閲覧専用。
 */
import { useEffect, useMemo } from "react";
import { useI18n } from "../i18n/useI18n";
import { colorAttr } from "../model/colors";
import { loadTable } from "../model/loader";
import { formatName, resolveColumnName, resolveTableName } from "../model/logicalName";
import { useAppStore } from "../model/store";
import { parseEdgeId, type Relation, type Table } from "../model/types";
import { cx } from "../lib/cx";
import { hrefs } from "./router";
import { Link } from "./Link";
import styles from "./TableInfo.module.scss";

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
}

export function TableInfo({ tableId, onNavigate }: TableInfoProps) {
  const { t } = useI18n();
  const table = useAppStore((s) => s.tables[tableId]);
  const error = useAppStore((s) => s.tableErrors[tableId]);
  const dictionary = useAppStore((s) => s.dictionary);
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);

  useEffect(() => {
    void loadTable(tableId);
  }, [tableId]);

  const indexEntry = index?.tables?.find((x) => x.id === tableId);

  // 被参照一覧（G-02）: index.relations から to === 自分 を拾う（物理・論理とも）
  const referencedBy = useMemo(
    () => (index?.relations ?? []).filter((r) => r.to === tableId && r.from !== tableId),
    [index, tableId],
  );

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

  return (
    <div className={styles.tableInfo}>
      {table.comment !== undefined && table.comment !== "" && (
        <p className={styles.tableComment}>{table.comment}</p>
      )}
      {(table.meta?.tags?.length ?? 0) > 0 && (
        <p className={styles.tableTags}>
          {table.meta?.tags?.map((tag) => (
            <span key={tag} className={styles.tag}>
              {tag}
            </span>
          ))}
        </p>
      )}
      {table.meta?.notes !== undefined && table.meta.notes !== "" && (
        <p className="table-notes">
          <span className="label">{t("table.notes")}: </span>
          {table.meta.notes}
        </p>
      )}

      <h3>{t("table.columns")}</h3>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("table.colPk")}</th>
              <th>{t("table.colName")}</th>
              <th>{t("table.colLogicalName")}</th>
              <th>{t("table.colType")}</th>
              <th>{t("table.colNullable")}</th>
              <th>{t("table.colDefault")}</th>
              <th>{t("table.colComment")}</th>
              <th>{t("table.tags")}</th>
              <th>{t("table.colNotes")}</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((c) => {
              const logical = resolveColumnName(table, c.name, dictionary);
              const meta = table.meta?.columns?.[c.name];
              return (
                <tr key={c.name} className={styles.columnRow} data-color={colorAttr(meta?.color)}>
                  <td className="center">
                    {pk.has(c.name) && <span className={cx(styles.keyBadge, styles.keyPk)}>PK</span>}
                    {fkCols.has(c.name) && <span className={cx(styles.keyBadge, styles.keyFk)}>FK</span>}
                  </td>
                  <td className="mono">{c.name}</td>
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
                  <td className="mono">
                    {c.type ?? c.logicalType ?? ""}
                    {c.autoIncrement === true && <span className="badge">{t("table.autoIncrement")}</span>}
                    {c.generated === true && <span className="badge">{t("table.generated")}</span>}
                  </td>
                  <td className="center">{c.nullable === true ? t("common.yes") : t("common.no")}</td>
                  <td className="mono">{c.default !== undefined ? String(c.default) : ""}</td>
                  <td>{c.comment ?? ""}</td>
                  <td>
                    {(meta?.tags?.length ?? 0) > 0 && (
                      <span className={styles.columnTags}>
                        {meta?.tags?.map((tag) => (
                          <span key={tag} className={styles.tag}>
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>{meta?.notes ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 制約は種類ごとに見出しを立て、1件 = 1枠で区切る（「制約」の下に種類を入れ子に
          していたが、階層を深くしても読みやすくならないため平坦に並べる） */}
      {(table.primaryKey?.length ?? 0) > 0 && (
        <>
          <h3>{t("table.primaryKey")}</h3>
          <ul className={styles.itemList}>
            <li className={styles.item}>
              <span className="mono">{table.primaryKey?.join(", ")}</span>
            </li>
          </ul>
        </>
      )}

      {(table.uniques?.length ?? 0) > 0 && (
        <>
          <h3>{t("table.uniques")}</h3>
          <ul className={styles.itemList}>
            {table.uniques?.map((u, i) => (
              <li key={u.name ?? i} className={styles.item}>
                <span className="mono">{u.columns.join(", ")}</span>
                {u.name !== undefined && <span className={styles.itemName}>{u.name}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {(table.indexes?.length ?? 0) > 0 && (
        <>
          <h3>{t("table.indexes")}</h3>
          <ul className={styles.itemList}>
            {table.indexes?.map((ix, i) => (
              <li key={ix.name ?? i} className={styles.item}>
                <span className="mono">{ix.columns.join(", ")}</span>
                {ix.unique === true && <span className="badge">unique</span>}
                {ix.name !== undefined && <span className={styles.itemName}>{ix.name}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 外部キーは被参照と同じ形（相手テーブル + カラム対応）で見せる。
          制約名などの詳細は虫眼鏡から開くリレーション詳細に寄せる */}
      {(table.foreignKeys?.length ?? 0) > 0 && (
        <>
          <h3>{t("table.foreignKeys")}</h3>
          <ul className={styles.itemList} data-testid="fk-list">
            {table.foreignKeys?.map((fk, i) => (
              <li key={fk.name ?? i} className={styles.item}>
                <TableLink tableId={fk.ref.table} onNavigate={onNavigate} />
                <span className="mono muted">({pairsText(fk.columns, fk.ref.columns)})</span>
                <RelationDetailButton relationId={edgeIdOf(table.id, "fk", fk.name)} />
              </li>
            ))}
          </ul>
        </>
      )}

      {(table.meta?.logicalUniques?.length ?? 0) > 0 && (
        <>
          <h3>{t("table.logicalUniques")}</h3>
          <ul className={styles.itemList}>
            {table.meta?.logicalUniques?.map((u, i) => (
              <li key={u.name ?? i} className={cx(styles.item, styles.itemLogical)}>
                <span className="mono">{u.columns.join(", ")}</span>
                {u.name !== undefined && <span className={styles.itemName}>{u.name}</span>}
                {u.notes !== undefined && <span className={styles.noteInline}>{u.notes}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {(table.meta?.logicalForeignKeys?.length ?? 0) > 0 && (
        <>
          <h3>{t("table.logicalForeignKeys")}</h3>
          <ul className={styles.itemList} data-testid="lfk-list">
            {table.meta?.logicalForeignKeys?.map((fk, i) => (
              <li key={fk.name ?? i} className={cx(styles.item, styles.itemLogical)}>
                <TableLink tableId={fk.ref.table} onNavigate={onNavigate} />
                <span className="mono muted">({pairsText(fk.columns, fk.ref.columns)})</span>
                {fk.notes !== undefined && <span className={styles.noteInline}>{fk.notes}</span>}
                <RelationDetailButton relationId={edgeIdOf(table.id, "lfk", fk.name)} />
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>{t("table.referencedBy")}</h3>
      {referencedBy.length === 0 ? (
        <p className="muted">{t("table.noReferences")}</p>
      ) : (
        <ul className={styles.itemList}>
          {referencedBy.map((r) => (
            <li key={r.id} className={cx(styles.item, r.kind === "logical" && styles.itemLogical)}>
              <RelationKindBadge relation={r} />
              <TableLink tableId={r.from} onNavigate={onNavigate} />
              <span className="mono muted">
                ({(r.columns ?? []).map(([from, to]) => `${from} → ${to}`).join(", ")})
              </span>
              <RelationDetailButton relationId={r.id} />
            </li>
          ))}
        </ul>
      )}

      <PagesSection table={table} onNavigate={onNavigate} />

      {table.dialect !== undefined && Object.keys(table.dialect).length > 0 && (
        <>
          <h3>{t("table.dialect")}</h3>
          <pre className={styles.dialectPre}>{JSON.stringify(table.dialect, null, 2)}</pre>
        </>
      )}
    </div>
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
    <button
      type="button"
      className={styles.detailButton}
      data-testid="relation-detail"
      title={t("relation.title")}
      aria-label={t("relation.title")}
      onClick={() => openDialog({ type: "relation", id: relationId })}
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

/** 所属ページ一覧（G-05 / O-04）。未配置なら明示する */
function PagesSection({ table, onNavigate }: { table: Table; onNavigate?: () => void }) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const manifest = useAppStore((s) => s.manifest);
  const entry = index?.tables?.find((x) => x.id === table.id);
  const diagramIds = entry?.diagrams ?? [];
  return (
    <>
      <h3>{t("table.pages")}</h3>
      {diagramIds.length === 0 ? (
        <p className="muted">{t("table.unplacedNote")}</p>
      ) : (
        // 制約・被参照と同じ「1件 = 1枠」で横に並べる
        <ul className={styles.itemList} data-testid="page-list">
          {diagramIds.map((id) => {
            const ref = manifest?.diagrams?.find((d) => d.id === id);
            return (
              <li key={id} className={styles.item}>
                <Link href={hrefs.erd(id, table.id)} onClick={onNavigate}>
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
