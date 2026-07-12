/**
 * テーブル詳細の共通表示（G-01〜G-05 / O-02 で共用）。
 * カラム表・制約・論理制約・被参照一覧・meta・配置ページを表示する。閲覧専用。
 */
import { useEffect, useMemo } from "react";
import { useI18n } from "../i18n/useI18n";
import { loadTable } from "../model/loader";
import { formatName, resolveColumnName, resolveTableName } from "../model/logicalName";
import { useAppStore } from "../model/store";
import { parseEdgeId, type Relation, type Table } from "../model/types";
import { hrefs } from "./router";
import { Link } from "./Link";

/** 参照先テーブルへのリンク（存在しなければ物理名のみ） */
export function TableLink({ tableId, onNavigate }: { tableId: string; onNavigate?: () => void }) {
  const index = useAppStore((s) => s.index);
  const nameDisplay = useAppStore((s) => s.nameDisplay);
  const it = index?.tables?.find((x) => x.id === tableId);
  if (!it) return <span className="table-link-missing">{tableId}</span>;
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

  return (
    <div className="table-info">
      {table.comment !== undefined && table.comment !== "" && (
        <p className="table-comment">{table.comment}</p>
      )}
      {(table.meta?.tags?.length ?? 0) > 0 && (
        <p className="table-tags">
          {table.meta?.tags?.map((tag) => (
            <span key={tag} className="tag">
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
              <th>{t("table.colNotes")}</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((c) => {
              const logical = resolveColumnName(table, c.name, dictionary);
              const meta = table.meta?.columns?.[c.name];
              return (
                <tr key={c.name}>
                  <td className="center">{pk.has(c.name) ? "🔑" : ""}</td>
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
                  <td>{meta?.notes ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3>{t("table.constraints")}</h3>
      <dl className="constraint-list">
        {(table.primaryKey?.length ?? 0) > 0 && (
          <>
            <dt>{t("table.primaryKey")}</dt>
            <dd className="mono">{table.primaryKey?.join(", ")}</dd>
          </>
        )}
        {(table.uniques?.length ?? 0) > 0 && (
          <>
            <dt>{t("table.uniques")}</dt>
            <dd>
              {table.uniques?.map((u, i) => (
                <div key={u.name ?? i} className="mono">
                  {u.name !== undefined && `${u.name} `}({u.columns.join(", ")})
                </div>
              ))}
            </dd>
          </>
        )}
        {(table.indexes?.length ?? 0) > 0 && (
          <>
            <dt>{t("table.indexes")}</dt>
            <dd>
              {table.indexes?.map((ix, i) => (
                <div key={ix.name ?? i} className="mono">
                  {ix.name !== undefined && `${ix.name} `}({ix.columns.join(", ")})
                  {ix.unique === true && <span className="badge">unique</span>}
                </div>
              ))}
            </dd>
          </>
        )}
        {(table.foreignKeys?.length ?? 0) > 0 && (
          <>
            <dt>{t("table.foreignKeys")}</dt>
            <dd>
              {table.foreignKeys?.map((fk, i) => (
                <div key={fk.name ?? i} className="mono">
                  {fk.name !== undefined && `${fk.name} `}({fk.columns.join(", ")}) →{" "}
                  <TableLink tableId={fk.ref.table} onNavigate={onNavigate} />(
                  {(fk.ref.columns ?? []).join(", ")})
                  {fk.onDelete !== undefined && <span className="badge">on delete {fk.onDelete}</span>}
                  {fk.onUpdate !== undefined && <span className="badge">on update {fk.onUpdate}</span>}
                </div>
              ))}
            </dd>
          </>
        )}
      </dl>

      {((table.meta?.logicalUniques?.length ?? 0) > 0 ||
        (table.meta?.logicalForeignKeys?.length ?? 0) > 0) && (
        <>
          <h3>{t("table.logicalConstraints")}</h3>
          <dl className="constraint-list logical">
            {(table.meta?.logicalUniques?.length ?? 0) > 0 && (
              <>
                <dt>{t("table.logicalUniques")}</dt>
                <dd>
                  {table.meta?.logicalUniques?.map((u, i) => (
                    <div key={u.name ?? i} className="mono">
                      {u.name !== undefined && `${u.name} `}({u.columns.join(", ")})
                      {u.notes !== undefined && <span className="note-inline">{u.notes}</span>}
                    </div>
                  ))}
                </dd>
              </>
            )}
            {(table.meta?.logicalForeignKeys?.length ?? 0) > 0 && (
              <>
                <dt>{t("table.logicalForeignKeys")}</dt>
                <dd>
                  {table.meta?.logicalForeignKeys?.map((fk, i) => (
                    <div key={fk.name ?? i} className="mono">
                      {fk.name !== undefined && `${fk.name} `}({fk.columns.join(", ")}) →{" "}
                      <TableLink tableId={fk.ref.table} onNavigate={onNavigate} />(
                      {(fk.ref.columns ?? []).join(", ")})
                      {fk.notes !== undefined && <span className="note-inline">{fk.notes}</span>}
                    </div>
                  ))}
                </dd>
              </>
            )}
          </dl>
        </>
      )}

      <h3>{t("table.referencedBy")}</h3>
      {referencedBy.length === 0 ? (
        <p className="muted">{t("table.noReferences")}</p>
      ) : (
        <ul className="reference-list">
          {referencedBy.map((r) => (
            <li key={r.id}>
              <RelationKindBadge relation={r} />
              <TableLink tableId={r.from} onNavigate={onNavigate} />{" "}
              <span className="mono muted">
                ({(r.columns ?? []).map(([from, to]) => `${from} → ${to}`).join(", ")})
              </span>
            </li>
          ))}
        </ul>
      )}

      <PagesSection table={table} onNavigate={onNavigate} />

      {table.dialect !== undefined && Object.keys(table.dialect).length > 0 && (
        <>
          <h3>{t("table.dialect")}</h3>
          <pre className="dialect-pre">{JSON.stringify(table.dialect, null, 2)}</pre>
        </>
      )}
    </div>
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
        <ul className="page-list">
          {diagramIds.map((id) => {
            const ref = manifest?.diagrams?.find((d) => d.id === id);
            return (
              <li key={id}>
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
