/**
 * エッジのダブルクリックで開くリレーション詳細ダイアログ（E-10）。
 * 種別・制約名・参照元/先・カラム対応・ON DELETE/UPDATE・カーディナリティ・注記を表示する。
 */
import { useEffect } from "react";
import { useI18n } from "../i18n/useI18n";
import { loadTable } from "../model/loader";
import { useAppStore } from "../model/store";
import { parseEdgeId } from "../model/types";
import { Dialog } from "./Dialog";
import { RelationKindBadge, TableLink } from "./TableInfo";
import styles from "./RelationDialog.module.scss";

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
