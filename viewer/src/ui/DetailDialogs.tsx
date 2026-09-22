/**
 * 閲覧用の詳細ダイアログ（テーブル詳細の一覧行の虫眼鏡・ER図のエッジのダブルクリックから開く）。
 *
 * - {@link RelationDialog}: リレーション（物理FK / 論理外部制約。E-10）
 * - {@link ConstraintInfoDialog}: ユニーク制約・インデックス・論理一意制約
 *
 * 一覧側は「読むための最小限」だけを出し、制約名などの細部はここに寄せる（一覧が横に
 * 伸びると、並んだ制約同士を見比べられなくなるため）。
 *
 * 注記（多重度の補足・論理外部制約・論理一意制約）は**テーブル画面から開いたとき**だけ、
 * その場で編集できる（R-05。サーバーモード）。ER図の閲覧ルートから開いたダイアログは
 * 読むだけ（P-11。ER図側の編集は編集ルートの RelationEditDialog）。
 */
import { useEffect, useRef } from "react";
import { useI18n } from "../i18n/useI18n";
import { loadTable } from "../model/loader";
import { useAppStore, type ConstraintKind } from "../model/store";
import { parseEdgeId, type Table } from "../model/types";
import { cx } from "../lib/cx";
import { Dialog } from "./Dialog";
import { InlineNotes } from "./InlineNotes";
import { useRoute } from "./router";
import { RelationKindBadge, TableLink } from "./TableInfo";
import styles from "./DetailDialogs.module.scss";

/**
 * テーブルを読み、一度読めたら手元に残す。注記の保存（saveTableMeta）は読み直しのため
 * 一瞬ストアから消すので、素直に追随すると保存中に本文が「読み込み中」へ戻り、
 * その場の入力欄ごと消えてしまう
 */
function useHeldTable(tableId: string | undefined): Table | undefined {
  const stored = useAppStore((s) => (tableId === undefined ? undefined : s.tables[tableId]));
  const held = useRef<{ id: string; table: Table } | null>(null);
  if (stored !== undefined && tableId !== undefined) held.current = { id: tableId, table: stored };
  if (stored !== undefined) return stored;
  const kept = held.current;
  return kept !== null && kept.id === tableId ? kept.table : undefined;
}

/** 注記をその場で編集できるか（テーブル画面から開いた・サーバーモード） */
function useCanEditNotes(): boolean {
  const serverMode = useAppStore((s) => s.serverMode === true);
  const kind = useRoute().kind;
  return serverMode && (kind === "table" || kind === "tableDoc");
}

export function RelationDialog({ relationId }: { relationId: string }) {
  const { t } = useI18n();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const canEdit = useCanEditNotes();
  const index = useAppStore((s) => s.index);
  const relation = index?.relations?.find((r) => r.id === relationId);
  const parts = parseEdgeId(relationId);

  // FK 定義（ON DELETE / UPDATE）と meta.relations（注記）は参照元テーブルのスキーマにある
  const fromTable = useHeldTable(relation?.from);
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
  // 論理外部制約は制約そのものにも注記を持つ（物理FK は定義が machine-owned なので持たない）。
  // 一覧には出さず、ここで読ませる
  const lfkAt =
    parts?.kind === "lfk"
      ? (fromTable?.meta?.logicalForeignKeys?.findIndex((f) => f.name === parts.constraintName) ?? -1)
      : -1;
  const lfk = lfkAt >= 0 ? fromTable?.meta?.logicalForeignKeys?.[lfkAt] : undefined;
  const relationMeta =
    parts !== null
      ? fromTable?.meta?.relations?.[`${parts.kind}:${parts.constraintName}`]
      : undefined;
  const explicit = relation.explicit ?? [];
  // 多重度の補足の書く先（物理FK は meta.relations、論理外部制約はドラフトの制約の行）
  const cardinalityTarget =
    parts === null || fromTable === undefined
      ? null
      : parts.kind === "fk"
        ? ({ kind: "physicalFk", tableId: relation.from, name: parts.constraintName } as const)
        : ({ kind: "logicalFkCardinality", tableId: relation.from, name: parts.constraintName } as const);
  const editable = canEdit && cardinalityTarget !== null;

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
          {/* 多重度の補足。編集ダイアログでもカーディナリティ欄の一部なので、同じ場所に置く */}
          {cardinalityTarget !== null && (editable || (relationMeta?.notes ?? "") !== "") && (
            <div className={styles.cardinalityNote}>
              <InlineNotes
                value={relationMeta?.notes ?? ""}
                target={cardinalityTarget}
                canEdit={editable}
                label={t("doc.editRelationNotes")}
                testId="relation-cardinality-notes"
              />
            </div>
          )}
        </dd>
        {lfk !== undefined && (editable || (lfk.notes ?? "") !== "") && (
          <>
            <dt>{t("relation.notes")}</dt>
            <dd>
              <InlineNotes
                value={lfk.notes ?? ""}
                target={{ kind: "logicalFk", tableId: relation.from, at: lfkAt, name: lfk.name }}
                canEdit={editable}
                label={t("doc.editRelationNotes")}
                testId="relation-notes"
                className={styles.notes}
              />
            </dd>
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
  const table = useHeldTable(tableId);
  const canEdit = useCanEditNotes();

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
        {logical && (canEdit || (notes ?? "") !== "") && (
          <>
            <dt>{t("constraint.notes")}</dt>
            <dd>
              <InlineNotes
                value={notes ?? ""}
                target={{ kind: "logicalUnique", tableId, at, name: entry.name }}
                canEdit={canEdit}
                label={t("doc.editConstraintNotes")}
                testId="constraint-notes-value"
                className={styles.notes}
              />
            </dd>
          </>
        )}
      </dl>
    </Dialog>
  );
}
