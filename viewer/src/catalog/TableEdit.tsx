/**
 * テーブル編集画面 `#/tables/<id>/edit`（O-03 / O-08 / O-09 / J-05 / P-01 / P-04 / P-06 / P-07 / P-11）。
 *
 * Phase4 の編集対象は human-owned（meta）のみ:
 * 論理名・タグ・注記・カラム個別の論理名 / 注記・論理制約・カーディナリティ。
 * machine-owned（カラム・物理制約）の編集とリネームの波及（J-01〜J-04）は後続フェーズ。
 *
 * 自動保存はしない（INV-4）。明示的な [保存] / Cmd/Ctrl+S でのみ書き込む。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { apiGet, apiPut, wpath } from "../model/api";
import { rememberOwnRevision } from "../model/editStore";
import { usePageEditStore } from "../model/pageEditStore";
import { invalidateTable, loadTable, reloadIndex } from "../model/loader";
import {
  buildDraft,
  draftToMeta,
  errorsAt,
  validateDraft,
  newUid,
  type DraftLogicalFk,
  type DraftLogicalUnique,
  type FieldError,
  type MetaDraft,
} from "../model/metaDraft";
import { useAppStore } from "../model/store";
import type { CardEnd, Table } from "../model/types";
import { Dialog } from "../ui/Dialog";
import { Link } from "../ui/Link";
import { NotFound } from "../ui/NotFound";
import { hrefs } from "../ui/router";

interface ServerIssue {
  path: string;
  code: string;
  message: string;
}

export function TableEdit({ tableId }: { tableId: string }) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const dictionary = useAppStore((s) => s.dictionary);
  const tables = useAppStore((s) => s.tables);
  const addToast = useAppStore((s) => s.addToast);
  // 編集ルート（#/tables/<id>/edit）にいる時点で編集モード。ロックは無い（H-11 廃止）。
  // 静的モードでは App が詳細画面へリダイレクトするため、ここは常にサーバーモード
  const sessionReady = useAppStore((s) => s.serverMode === true);

  const [committed, setCommitted] = useState<{ table: Table; baseHash: string } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<MetaDraft | null>(null);
  const [initialJson, setInitialJson] = useState("");
  const [clientErrors, setClientErrors] = useState<FieldError[]>([]);
  const [serverIssues, setServerIssues] = useState<ServerIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  // committed の読み込み: ファイルを読み直してから baseHash を取る（§8.4 の読み込み時点ハッシュ）
  const reload = useCallback(async () => {
    setCommitted(null);
    setDraft(null);
    setLoadFailed(false);
    invalidateTable(tableId);
    const table = await loadTable(tableId);
    if (!table) {
      setLoadFailed(true);
      return;
    }
    try {
      const res = await apiGet(wpath(`/tables/${encodeURIComponent(tableId)}`));
      if (res.status !== 200) {
        setLoadFailed(true);
        return;
      }
      const body = JSON.parse(res.body) as { baseHash: string };
      setCommitted({ table, baseHash: body.baseHash });
      const d = buildDraft(table);
      setDraft(d);
      setInitialJson(JSON.stringify(d));
      setClientErrors([]);
      setServerIssues([]);
    } catch {
      setLoadFailed(true);
    }
  }, [tableId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const dirty = useMemo(
    () => draft !== null && JSON.stringify(draft) !== initialJson,
    [draft, initialJson],
  );

  // 保存・編集終了はヘッダ（EditControls）から行う。編集画面がマウント中だけ、
  // ヘッダが操作できるようコントローラを登録する（pageEditStore）。
  // 未保存があってもリロード・他ページ遷移は妨げない（確認は終了操作に限定）。
  const setController = usePageEditStore((s) => s.setController);
  const saveRef = useRef<(force: boolean) => void>(() => {});
  useEffect(() => {
    setController({
      dirty,
      saving,
      canSave: committed !== null,
      save: () => saveRef.current(false),
      end: () => {
        location.hash = hrefs.table(tableId);
      },
    });
    return () => setController(null);
  }, [dirty, saving, committed, tableId, setController]);

  const existingTableIds = useMemo(
    () => new Set((index?.tables ?? []).map((it) => it.id)),
    [index],
  );

  const save = useCallback(
    async (force: boolean) => {
      if (!committed || !draft || saving) return;
      const errors = validateDraft(draft, committed.table, existingTableIds, tables);
      setClientErrors(errors);
      setServerIssues([]);
      if (errors.length > 0) {
        addToast(t("tableEdit.validationFailed"));
        return;
      }
      const meta = draftToMeta(draft, committed.table);
      const tableBody: Record<string, unknown> = { ...committed.table };
      if (Object.keys(meta).length > 0) {
        tableBody["meta"] = meta;
      } else {
        delete tableBody["meta"];
      }
      setSaving(true);
      try {
        const res = await apiPut(wpath(`/tables/${encodeURIComponent(tableId)}`), {
          baseHash: committed.baseHash,
          force,
          table: tableBody,
        });
        if (res.status === 200) {
          const body = JSON.parse(res.body) as {
            revision: string;
            newHash: string;
            warnings: ServerIssue[];
          };
          rememberOwnRevision(body.revision);
          // 保存後も編集は継続する（ER図・カラム編集と同じ）。次の保存に備えて baseHash を
          // 更新し、初期スナップショットを現在の draft に置き換えて未保存フラグを落とす。
          setCommitted((c) => (c ? { table: c.table, baseHash: body.newHash } : c));
          setInitialJson(JSON.stringify(draft));
          // 他の画面（詳細・ER図）に反映する（自分のリビジョンの SSE は無視されるため）
          invalidateTable(tableId);
          void loadTable(tableId);
          void reloadIndex(body.revision);
          addToast(
            body.warnings.length > 0
              ? t("tableEdit.savedWarnings", { n: body.warnings.length })
              : t("tableEdit.saved"),
          );
        } else if (res.status === 409) {
          setConflict(true);
        } else if (res.status === 422) {
          const body = JSON.parse(res.body) as { errors: ServerIssue[]; warnings: ServerIssue[] };
          setServerIssues(body.errors);
          addToast(t("tableEdit.validationFailed"));
        } else {
          addToast(`${t("save.failed")} (HTTP ${res.status})`);
        }
      } catch {
        addToast(`${t("save.failed")} (network)`);
      } finally {
        setSaving(false);
      }
    },
    [committed, draft, saving, existingTableIds, tables, tableId, addToast, t],
  );
  saveRef.current = save;

  // N-10: Cmd/Ctrl+S で保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (loadFailed) {
    return <NotFound path={`tables/${tableId}/edit`} />;
  }
  if (!committed || !draft) {
    return <div className="catalog-page">{t("table.loading")}</div>;
  }
  const table = committed.table;
  const allErrors: { path: string }[] = [...clientErrors, ...serverIssues];

  const update = (patch: Partial<MetaDraft>) => setDraft({ ...draft, ...patch });

  return (
    <div className="catalog-page table-edit">
      <div className="catalog-header">
        <h2>
          {t("tableEdit.title")}: <span className="mono">{tableId}</span>
        </h2>
        {/* 保存・変更の破棄・編集終了はヘッダ（EditControls）に集約 */}
      </div>

      {allErrors.length > 0 && (
        <div className="error-banner">
          {t("tableEdit.validationFailed")}
          <ul className="error-list">
            {clientErrors.map((e, i) => (
              <li key={`c${i}`} className="mono">
                {e.path}: <ErrorText error={e} />
              </li>
            ))}
            {serverIssues.map((e, i) => (
              <li key={`s${i}`} className="mono">
                {e.path}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <fieldset className="edit-form" disabled={!sessionReady || saving}>
        {/* ---- 基本情報（P-01 / J-05） ---- */}
        <h3>{t("tableEdit.sectionBasic")}</h3>
        <div className="form-grid">
          <label>{t("tableEdit.displayName")}</label>
          <input
            type="text"
            value={draft.displayName}
            onChange={(e) => update({ displayName: e.target.value })}
          />
          <label>{t("tableEdit.tags")}</label>
          <input type="text" value={draft.tags} onChange={(e) => update({ tags: e.target.value })} />
          <label>{t("tableEdit.notes")}</label>
          <textarea
            rows={2}
            value={draft.notes}
            onChange={(e) => update({ notes: e.target.value })}
          />
        </div>

        {/* ---- カラム個別の論理名・注記（P-04） ---- */}
        <h3>{t("tableEdit.sectionColumns")}</h3>
        <p className="muted form-hint">
          {t("tableEdit.columnsHint")}{" "}
          <Link href={hrefs.columns()}>{t("nav.columns")}</Link>
        </p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("table.colName")}</th>
                <th>{t("table.colType")}</th>
                <th>{t("table.colLogicalName")}</th>
                <th>{t("table.colNotes")}</th>
              </tr>
            </thead>
            <tbody>
              {table.columns.map((c) => {
                const cm = draft.columns[c.name] ?? { displayName: "", notes: "" };
                const dictValue = dictionary?.columns?.[c.name];
                return (
                  <tr key={c.name}>
                    <td className="mono">{c.name}</td>
                    <td className="mono muted">{c.type ?? c.logicalType ?? ""}</td>
                    <td>
                      <input
                        type="text"
                        value={cm.displayName}
                        placeholder={
                          dictValue !== undefined
                            ? t("tableEdit.dictValue", { value: dictValue })
                            : ""
                        }
                        onChange={(e) =>
                          update({
                            columns: {
                              ...draft.columns,
                              [c.name]: { ...cm, displayName: e.target.value },
                            },
                          })
                        }
                      />
                      {cm.displayName.trim() !== "" && dictValue !== undefined && (
                        <span className="badge badge-warn" title={t("tableEdit.dictValue", { value: dictValue })}>
                          {t("tableEdit.overridesDict")}
                        </span>
                      )}
                    </td>
                    <td>
                      <input
                        type="text"
                        value={cm.notes}
                        onChange={(e) =>
                          update({
                            columns: {
                              ...draft.columns,
                              [c.name]: { ...cm, notes: e.target.value },
                            },
                          })
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ---- 論理制約（P-06 / P-07） ---- */}
        <h3>{t("tableEdit.sectionLogical")}</h3>
        <p className="muted form-hint">ⓘ {t("tableEdit.logicalHint")}</p>

        <h4>{t("table.logicalUniques")}</h4>
        {draft.logicalUniques.map((u, i) => (
          <LogicalUniqueRow
            key={u.uid}
            row={u}
            table={table}
            errors={errorsAt(allErrors, `meta.logicalUniques[${i}]`)}
            onChange={(next) =>
              update({
                logicalUniques: draft.logicalUniques.map((x) => (x.uid === u.uid ? next : x)),
              })
            }
            onRemove={() =>
              update({ logicalUniques: draft.logicalUniques.filter((x) => x.uid !== u.uid) })
            }
          />
        ))}
        <button
          type="button"
          className="button-link"
          onClick={() =>
            update({
              logicalUniques: [
                ...draft.logicalUniques,
                { uid: newUid(), name: "", columns: [], notes: "" },
              ],
            })
          }
        >
          {t("tableEdit.addLogicalUnique")}
        </button>

        <h4>{t("table.logicalForeignKeys")}</h4>
        {draft.logicalForeignKeys.map((fk, i) => (
          <LogicalFkRow
            key={fk.uid}
            row={fk}
            table={table}
            errors={errorsAt(allErrors, `meta.logicalForeignKeys[${i}]`)}
            onChange={(next) =>
              update({
                logicalForeignKeys: draft.logicalForeignKeys.map((x) =>
                  x.uid === fk.uid ? next : x,
                ),
              })
            }
            onRemove={() =>
              update({
                logicalForeignKeys: draft.logicalForeignKeys.filter((x) => x.uid !== fk.uid),
              })
            }
          />
        ))}
        <button
          type="button"
          className="button-link"
          onClick={() =>
            update({
              logicalForeignKeys: [
                ...draft.logicalForeignKeys,
                { uid: newUid(), name: "", columns: [], refTable: "", refColumns: [], notes: "" },
              ],
            })
          }
        >
          {t("tableEdit.addLogicalFk")}
        </button>

        {/* ---- カーディナリティ（P-11） ---- */}
        <CardinalitySection table={table} draft={draft} onChange={update} />
      </fieldset>

      {conflict && (
        <Dialog title={t("edit.conflict.title")} onClose={() => setConflict(false)}>
          <p>{t("tableEdit.conflictBody")}</p>
          <div className="dialog-actions">
            <button
              type="button"
              onClick={() => {
                setConflict(false);
                void reload();
              }}
            >
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

// ------------------------------------------------------------- 部品

function ErrorText({ error }: { error: FieldError }) {
  const { t } = useI18n();
  const key = `vErr.${error.code}` as Parameters<typeof t>[0];
  const suffix = error.params?.["name"] !== undefined ? `: ${error.params["name"]}` : "";
  return (
    <>
      {t(key)}
      {suffix}
    </>
  );
}

function FieldErrorList({ errors }: { errors: { path: string }[] }) {
  if (errors.length === 0) return null;
  return <span className="field-error">⚠</span>;
}

/** カラムの順序つき選択（チップ + 追加セレクト）。複合キーの順序を保持する */
function ColumnPicker({
  selected,
  candidates,
  onChange,
  addLabel,
}: {
  selected: string[];
  candidates: string[];
  onChange: (next: string[]) => void;
  addLabel: string;
}) {
  const available = candidates.filter((c) => !selected.includes(c));
  return (
    <span className="column-picker">
      {selected.map((c) => (
        <span key={c} className="column-chip mono">
          {c}
          <button
            type="button"
            aria-label="remove"
            onClick={() => onChange(selected.filter((x) => x !== c))}
          >
            ×
          </button>
        </span>
      ))}
      {available.length > 0 && (
        <select value="" onChange={(e) => e.target.value !== "" && onChange([...selected, e.target.value])}>
          <option value="">{addLabel}</option>
          {available.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

function LogicalUniqueRow({
  row,
  table,
  errors,
  onChange,
  onRemove,
}: {
  row: DraftLogicalUnique;
  table: Table;
  errors: { path: string }[];
  onChange: (next: DraftLogicalUnique) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const columnNames = table.columns.map((c) => c.name);
  return (
    <div className={"constraint-row" + (errors.length > 0 ? " has-error" : "")}>
      <input
        type="text"
        className="mono constraint-name"
        placeholder={t("tableEdit.namePlaceholder")}
        value={row.name}
        onChange={(e) => onChange({ ...row, name: e.target.value })}
      />
      <ColumnPicker
        selected={row.columns}
        candidates={columnNames}
        onChange={(columns) => onChange({ ...row, columns })}
        addLabel={t("tableEdit.addColumn")}
      />
      <input
        type="text"
        className="constraint-notes"
        placeholder={t("tableEdit.notes")}
        value={row.notes}
        onChange={(e) => onChange({ ...row, notes: e.target.value })}
      />
      <button type="button" className="button-link danger" onClick={onRemove}>
        {t("tableEdit.remove")}
      </button>
      <FieldErrorList errors={errors} />
    </div>
  );
}

function LogicalFkRow({
  row,
  table,
  errors,
  onChange,
  onRemove,
}: {
  row: DraftLogicalFk;
  table: Table;
  errors: { path: string }[];
  onChange: (next: DraftLogicalFk) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);
  const target = useAppStore((s) => (row.refTable !== "" ? s.tables[row.refTable] : undefined));
  const columnNames = table.columns.map((c) => c.name);

  // 参照先テーブルのスキーマをオンデマンドで読む（参照先カラムのドロップダウン用）
  useEffect(() => {
    if (row.refTable !== "" && row.refTable !== table.id) {
      void loadTable(row.refTable);
    }
  }, [row.refTable, table.id]);
  const targetColumns =
    row.refTable === table.id
      ? columnNames
      : (target?.columns ?? []).map((c) => c.name);

  return (
    <div className={"constraint-row" + (errors.length > 0 ? " has-error" : "")}>
      <input
        type="text"
        className="mono constraint-name"
        placeholder={t("tableEdit.namePlaceholder")}
        value={row.name}
        onChange={(e) => onChange({ ...row, name: e.target.value })}
      />
      <ColumnPicker
        selected={row.columns}
        candidates={columnNames}
        onChange={(columns) => onChange({ ...row, columns })}
        addLabel={t("tableEdit.addColumn")}
      />
      <span className="constraint-arrow">→</span>
      <select
        className="mono"
        value={row.refTable}
        onChange={(e) => onChange({ ...row, refTable: e.target.value, refColumns: [] })}
      >
        <option value="">{t("tableEdit.refTable")}…</option>
        {(index?.tables ?? []).map((it) => (
          <option key={it.id} value={it.id}>
            {it.id}
          </option>
        ))}
      </select>
      {row.refTable !== "" && (
        <ColumnPicker
          selected={row.refColumns}
          candidates={targetColumns}
          onChange={(refColumns) => onChange({ ...row, refColumns })}
          addLabel={t("tableEdit.addColumn")}
        />
      )}
      <input
        type="text"
        className="constraint-notes"
        placeholder={t("tableEdit.notes")}
        value={row.notes}
        onChange={(e) => onChange({ ...row, notes: e.target.value })}
      />
      <button type="button" className="button-link danger" onClick={onRemove}>
        {t("tableEdit.remove")}
      </button>
      <FieldErrorList errors={errors} />
    </div>
  );
}

/**
 * カーディナリティの設定（P-11）。物理 FK + 論理外部制約の各リレーションについて、
 * 導出値（index.js の解決結果）を既定とし、meta.relations で上書きする。
 */
function CardinalitySection({
  table,
  draft,
  onChange,
}: {
  table: Table;
  draft: MetaDraft;
  onChange: (patch: Partial<MetaDraft>) => void;
}) {
  const { t } = useI18n();
  const index = useAppStore((s) => s.index);

  const rows = useMemo(() => {
    const out: { key: string; label: string; savedName: boolean }[] = [];
    for (const fk of table.foreignKeys ?? []) {
      if (fk.name === undefined) continue;
      out.push({
        key: `fk:${fk.name}`,
        label: `${fk.name} (${fk.columns.join(", ")}) → ${fk.ref.table}`,
        savedName: true,
      });
    }
    for (const fk of draft.logicalForeignKeys) {
      if (fk.name.trim() === "") continue; // 名前が決まってから設定できる（自動生成前は対象外）
      out.push({
        key: `lfk:${fk.name.trim()}`,
        label: `${fk.name.trim()} (${fk.columns.join(", ")}) → ${fk.refTable}`,
        savedName: false,
      });
    }
    return out;
  }, [table, draft.logicalForeignKeys]);

  if (rows.length === 0) return null;

  const resolvedOf = (key: string): string => {
    const rel = (index?.relations ?? []).find((r) => r.id === `${table.id}#${key}`);
    if (!rel?.cardinality) return "—";
    return `${rel.cardinality.parent ?? "?"} / ${rel.cardinality.child ?? "?"}`;
  };

  const rowValue = (key: string) => draft.relations[key] ?? { parent: "" as const, child: "" as const, notes: "" };
  const setRow = (key: string, patch: Partial<{ parent: "" | CardEnd; child: "" | CardEnd; notes: string }>) => {
    const current = rowValue(key);
    onChange({ relations: { ...draft.relations, [key]: { ...current, ...patch } } });
  };

  return (
    <>
      <h3>{t("tableEdit.sectionCardinality")}</h3>
      <p className="muted form-hint">{t("tableEdit.cardinalityHint")}</p>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("relation.name")}</th>
              <th>{t("tableEdit.derivedNow")}</th>
              <th>{t("relation.parentSide")}</th>
              <th>{t("relation.childSide")}</th>
              <th>{t("table.colNotes")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const v = rowValue(r.key);
              return (
                <tr key={r.key}>
                  <td className="mono">{r.label}</td>
                  <td className="mono muted">{resolvedOf(r.key)}</td>
                  <td>
                    <select
                      value={v.parent}
                      onChange={(e) => setRow(r.key, { parent: e.target.value as "" | CardEnd })}
                    >
                      <option value="">{t("tableEdit.auto")}</option>
                      <option value="0..1">0..1</option>
                      <option value="1..1">1..1</option>
                    </select>
                  </td>
                  <td>
                    <select
                      value={v.child}
                      onChange={(e) => setRow(r.key, { child: e.target.value as "" | CardEnd })}
                    >
                      <option value="">{t("tableEdit.auto")}</option>
                      <option value="0..1">0..1</option>
                      <option value="1..1">1..1</option>
                      <option value="0..N">0..N</option>
                      <option value="1..N">1..N</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      value={v.notes}
                      onChange={(e) => setRow(r.key, { notes: e.target.value })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
