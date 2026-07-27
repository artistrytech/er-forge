/**
 * 閲覧用の詳細ダイアログ（テーブル詳細の一覧行の虫眼鏡・ER図のエッジのダブルクリックから開く）。
 *
 * - {@link RelationDialog}: リレーション（物理FK / 論理外部制約。E-10）
 * - {@link ConstraintInfoDialog}: ユニーク制約・インデックス・論理一意制約
 *
 * 一覧側は「読むための最小限」だけを出し、制約名などの細部はここに寄せる（一覧が横に
 * 伸びると、並んだ制約同士を見比べられなくなるため）。
 */
import { useEffect } from "react";
import { useI18n } from "../i18n/useI18n";
import { loadTable } from "../model/loader";
import { useAppStore, type ConstraintKind } from "../model/store";
import { parseEdgeId } from "../model/types";
import { cx } from "../lib/cx";
import { Dialog } from "./Dialog";
import { RelationKindBadge, TableLink } from "./TableInfo";
import styles from "./DetailDialogs.module.scss";

export function RelationDialog({ relationId }: { relationId: string }) {
  const { t } = useI18n();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const index = useAppStore((s) => s.index);
  const relation = index?.relations?.find((r) => r.id === relationId);
  const parts = parseEdgeId(relationId);

  // FK 定義（ON DELETE / UPDATE）と meta.relations（注記）は参照元テーブルのスキーマにある
  const fromTable = useAppStore((s) => (relation ? s.tables[relation.from] : undefined));
  useEffect(() => {
    if (relation) void loadTable(relation.from);
  }, [relation]);

  if (!relation) {
    return (
      <Dialog title={t("relation.title")} onClose={closeDialog}>
        <p className="error-text">{t("relation.notFound", { id: relationId })}</p>
      </Dialog>
    );
  }

  const fk =
    parts?.kind === "fk"
      ? fromTable?.foreignKeys?.find((f) => f.name === parts.constraintName)
      : undefined;
  const relationMeta =
    parts !== null
      ? fromTable?.meta?.relations?.[`${parts.kind}:${parts.constraintName}`]
      : undefined;
  const explicit = relation.explicit ?? [];

  return (
    <Dialog title={t("relation.title")} onClose={closeDialog}>
      <dl className={styles.detailGrid}>
        <dt>{t("relation.kind")}</dt>
        <dd>
          <RelationKindBadge relation={relation} />
        </dd>
        <dt>{t("relation.name")}</dt>
        <dd className="mono">{parts?.constraintName ?? relationId}</dd>
        <dt>{t("relation.from")}</dt>
        <dd>
          <TableLink tableId={relation.from} onNavigate={closeDialog} />
        </dd>
        <dt>{t("relation.to")}</dt>
        <dd>
          <TableLink tableId={relation.to} onNavigate={closeDialog} />
          {relation.dangling === true && <span className="error-text"> {t("relation.dangling")}</span>}
        </dd>
        <dt>{t("relation.columns")}</dt>
        <dd className="mono">
          {(relation.columns ?? []).map(([from, to], i) => (
            <div key={i}>
              {from} → {to}
            </div>
          ))}
        </dd>
        {fk?.onDelete !== undefined && (
          <>
            <dt>{t("relation.onDelete")}</dt>
            <dd className="mono">{fk.onDelete}</dd>
          </>
        )}
        {fk?.onUpdate !== undefined && (
          <>
            <dt>{t("relation.onUpdate")}</dt>
            <dd className="mono">{fk.onUpdate}</dd>
          </>
        )}
        <dt>{t("relation.cardinality")}</dt>
        <dd>
          <div>
            {t("relation.parentSide")}: <span className="mono">{relation.cardinality?.parent ?? "?"}</span>{" "}
            <span className="muted">
              ({explicit.includes("parent") ? t("relation.explicit") : t("relation.derived")})
            </span>
          </div>
          <div>
            {t("relation.childSide")}: <span className="mono">{relation.cardinality?.child ?? "?"}</span>{" "}
            <span className="muted">
              ({explicit.includes("child") ? t("relation.explicit") : t("relation.derived")})
            </span>
          </div>
        </dd>
        {relationMeta?.notes !== undefined && (
          <>
            <dt>{t("relation.notes")}</dt>
            <dd>{relationMeta.notes}</dd>
          </>
        )}
      </dl>
    </Dialog>
  );
}

/**
 * ユニーク制約・インデックス・論理一意制約の詳細。
 * 名前を持たない制約もあるため、テーブル内の位置（at）で指す。
 */
export function ConstraintInfoDialog({
  tableId,
  kind,
  at,
}: {
  tableId: string;
  kind: ConstraintKind;
  at: number;
}) {
  const { t } = useI18n();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const table = useAppStore((s) => s.tables[tableId]);

  useEffect(() => {
    void loadTable(tableId);
  }, [tableId]);

  const entry =
    kind === "unique"
      ? table?.uniques?.[at]
      : kind === "index"
        ? table?.indexes?.[at]
        : table?.meta?.logicalUniques?.[at];

  if (!entry) {
    return (
      <Dialog title={t("constraint.title")} onClose={closeDialog}>
        <p className="muted">{table === undefined ? t("table.loading") : t("constraint.notFound")}</p>
      </Dialog>
    );
  }

  const logical = kind === "logicalUnique";
  const kindLabel =
    kind === "unique"
      ? t("constraint.kindUnique")
      : kind === "index"
        ? t("constraint.kindIndex")
        : t("constraint.kindLogicalUnique");
  // インデックスのユニーク指定と、論理一意制約の注記はそれぞれの種別にしかない
  const unique = kind === "index" ? (entry as { unique?: boolean }).unique === true : undefined;
  const notes = logical ? (entry as { notes?: string }).notes : undefined;

  return (
    <Dialog title={t("constraint.title")} onClose={closeDialog}>
      <dl className={styles.detailGrid}>
        <dt>{t("constraint.kind")}</dt>
        <dd>
          <span className={cx("badge", logical ? "badge-logical" : "badge-physical")}>
            {kindLabel}
          </span>
        </dd>
        <dt>{t("constraint.table")}</dt>
        <dd>
          <TableLink tableId={tableId} onNavigate={closeDialog} />
        </dd>
        <dt>{t("constraint.name")}</dt>
        <dd className="mono">
          {entry.name ?? <span className="muted">{t("constraint.noName")}</span>}
        </dd>
        <dt>{t("constraint.columns")}</dt>
        {/* 複合キーは順序に意味があるため、番号を振って1行ずつ縦に並べる */}
        <dd className="mono">
          {entry.columns.map((c, i) => (
            <div key={c}>
              <span className={styles.ordinal}>{i + 1}</span>
              {c}
            </div>
          ))}
        </dd>
        {unique !== undefined && (
          <>
            <dt>{t("constraint.unique")}</dt>
            <dd>{unique ? t("common.yes") : t("common.no")}</dd>
          </>
        )}
        {notes !== undefined && notes !== "" && (
          <>
            <dt>{t("constraint.notes")}</dt>
            <dd>{notes}</dd>
          </>
        )}
      </dl>
    </Dialog>
  );
}
