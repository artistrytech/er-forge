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
  EMPTY_CARDINALITY,
  buildDraft,
  draftToMeta,
  errorsAt,
  generateConstraintName,
  validateDraft,
  type DraftColumnMeta,
  type FieldError,
  type MetaDraft,
} from "../model/metaDraft";
import { colorAttr, isColorToken } from "../model/colors";
import { useAppStore } from "../model/store";
import type { Table } from "../model/types";
import {
  CardinalityBadge,
  ConstraintList,
  ConstraintRow,
  FkDetail,
  LogicalFkDialog,
  LogicalUniqueDialog,
  PhysicalFkDialog,
} from "./ConstraintDialog";
import { NotesCell, NotesDialog } from "./NotesDialog";
import { ColorSelect } from "../ui/ColorSelect";
import { Dialog } from "../ui/Dialog";
import { Forbidden } from "../ui/Forbidden";
import { Link } from "../ui/Link";
import { NotFound } from "../ui/NotFound";
import { ScrollTable } from "../ui/ScrollTable";
import { TagInput } from "../ui/TagInput";
import { hrefs } from "../ui/router";
import styles from "./TableEdit.module.scss";

interface ServerIssue {
  path: string;
  code: string;
  message: string;
}

const EMPTY_COLUMN_DRAFT: DraftColumnMeta = { displayName: "", tags: [], color: "", notes: "" };

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
  /**
   * 読み込みに失敗した理由。**403 は「見つからない」と分けて扱う**（§8.5）。
   * トークン不一致は閲覧が全部できるのに編集だけ拒まれるため、
   * 「見つかりません」に混ぜると原因に辿り着けない
   */
  const [loadError, setLoadError] = useState<"notFound" | "forbidden" | null>(null);
  const [draft, setDraft] = useState<MetaDraft | null>(null);
  const [initialJson, setInitialJson] = useState("");
  const [clientErrors, setClientErrors] = useState<FieldError[]>([]);
  const [serverIssues, setServerIssues] = useState<ServerIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  /** 論理制約の作成・編集ダイアログ（uid=null は新規追加。P-06 / P-07） */
  const [editing, setEditing] = useState<{ kind: "unique" | "fk"; uid: number | null } | null>(null);
  /** カーディナリティを設定中の物理FK（制約名。P-11。定義そのものは編集できない） */
  const [editingPhysicalFk, setEditingPhysicalFk] = useState<string | null>(null);
  /** 注記を編集中のカラム（P-04）。本文はモーダルでマルチライン入力する */
  const [notesColumn, setNotesColumn] = useState<string | null>(null);

  // committed の読み込み: ファイルを読み直してから baseHash を取る（§8.4 の読み込み時点ハッシュ）
  const reload = useCallback(async () => {
    setCommitted(null);
    setDraft(null);
    setLoadError(null);
    setEditing(null);
    setEditingPhysicalFk(null);
    setNotesColumn(null);
    invalidateTable(tableId);
    const table = await loadTable(tableId);
    if (!table) {
      setLoadError("notFound");
      return;
    }
    try {
      const res = await apiGet(wpath(`/tables/${encodeURIComponent(tableId)}`));
      if (res.status !== 200) {
        setLoadError(res.status === 403 ? "forbidden" : "notFound");
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
      setLoadError("notFound");
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
      // 戻り先は最後に使っていた表示モード（詳細 / ドキュメント。R-02）
      end: () => {
        location.hash = hrefs.tableIn(useAppStore.getState().tablesView, tableId);
      },
    });
    return () => setController(null);
  }, [dirty, saving, committed, tableId, setController]);

  const existingTableIds = useMemo(
    () => new Set((index?.tables ?? []).map((it) => it.id)),
    [index],
  );

  // タグ候補（P-12）: index.js の使用中タグ（全テーブル未ロードでも引ける）＋ カラム辞書の
  // 共通タグ（index には載らない。P §4.3）＋ 編集中に追加したタグ。
  // 最後のを混ぜるのは、テーブルに付けたタグをカラムでもすぐ選べるようにするため
  const tagCandidates = useMemo(() => {
    const all = new Set(index?.tagsUsed ?? []);
    for (const entry of Object.values(dictionary?.columns ?? {})) {
      for (const tag of entry.tags ?? []) all.add(tag);
    }
    for (const tag of draft?.tags ?? []) all.add(tag);
    for (const cm of Object.values(draft?.columns ?? {})) {
      for (const tag of cm.tags) all.add(tag);
    }
    return [...all].sort((a, b) => a.localeCompare(b, "ja"));
  }, [index, dictionary, draft]);

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
        } else if (res.status === 403) {
          // トークン不一致（§8.5）。HTTP コードだけ出しても次の手が分からない
          addToast(t("save.forbidden"));
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

  if (loadError === "forbidden") {
    return (
      <Forbidden
        scope="edit"
        backHref={hrefs.tableIn(useAppStore.getState().tablesView, tableId)}
        backLabel={t("forbidden.toDetail")}
      />
    );
  }
  if (loadError !== null) {
    return <NotFound path={`tables/${tableId}/edit`} />;
  }
  if (!committed || !draft) {
    return <div className="catalog-page">{t("table.loading")}</div>;
  }
  const table = committed.table;
  const allErrors: { path: string }[] = [...clientErrors, ...serverIssues];

  // 更新は必ず関数形式で行う。タグ入力は blur を少し遅らせて確定するため、
  // 直前に別のフィールド（色など）を触ると、閉じ込めた draft で上書きして戻してしまう
  const update = (patch: Partial<MetaDraft>) =>
    setDraft((d) => (d === null ? d : { ...d, ...patch }));
  const updateColumn = (name: string, patch: Partial<DraftColumnMeta>) =>
    setDraft((d) =>
      d === null
        ? d
        : {
            ...d,
            columns: {
              ...d.columns,
              [name]: { ...(d.columns[name] ?? EMPTY_COLUMN_DRAFT), ...patch },
            },
          },
    );

  // 制約名の自動生成は保存時に行われる（draftToMeta）。一覧とダイアログでは同じ規則で
  // 予定名を先に見せる。「使用済み」は自分以外の名前（自分の名前で連番が付かないように）
  const takenNames = (kind: "unique" | "fk", selfUid: number | null): Set<string> => {
    const rows = kind === "unique" ? draft.logicalUniques : draft.logicalForeignKeys;
    return new Set(
      rows
        .filter((r) => r.uid !== selfUid)
        .map((r) => r.name.trim())
        .filter((n) => n !== ""),
    );
  };
  const autoNameOf = (prefix: "luk" | "lfk", uid: number, columns: string[]): string =>
    generateConstraintName(
      prefix,
      table.name,
      columns,
      takenNames(prefix === "luk" ? "unique" : "fk", uid),
    );
  /** ダイアログの確定: 既存 uid なら差し替え、無ければ末尾に追加する */
  const upsert = <T extends { uid: number }>(rows: T[], next: T): T[] =>
    rows.some((x) => x.uid === next.uid)
      ? rows.map((x) => (x.uid === next.uid ? next : x))
      : [...rows, next];

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
          <TagInput
            value={draft.tags}
            candidates={tagCandidates}
            disabled={!sessionReady || saving}
            testId="table-tags"
            onChange={(tags) => update({ tags })}
          />
          {/* 色はタグとは独立した指定（P-13）。タグから色は導出しない */}
          <label>{t("tableEdit.color")}</label>
          <ColorSelect
            value={draft.color}
            disabled={!sessionReady || saving}
            testId="table-color"
            onChange={(color) => update({ color })}
          />
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
        {/* 詳細画面と同じく、カラムが多いテーブルでフォームが縦に伸びきらないよう
            表の中だけをスクロールさせる（ヘッダは ScrollTable が固定する） */}
        <ScrollTable
          className={styles.columnsScroll}
          testId="edit-columns"
          head={
            <tr>
              <th>{t("table.colName")}</th>
              <th>{t("table.colType")}</th>
              <th>{t("table.colLogicalName")}</th>
              <th>{t("table.tags")}</th>
              <th>{t("tableEdit.color")}</th>
              <th>{t("table.colNotes")}</th>
            </tr>
          }
        >
          {table.columns.map((c) => {
            const cm = draft.columns[c.name] ?? EMPTY_COLUMN_DRAFT;
            const dictEntry = dictionary?.columns?.[c.name];
            const dictValue = dictEntry?.displayName;
            // 共通設定（カラム辞書）の値。タグは消せない・色は上書きできる、を見せる
            const commonTags = dictEntry?.tags ?? [];
            const dictColor = dictEntry?.color ?? "";
            return (
              <tr key={c.name} data-color={colorAttr(cm.color !== "" ? cm.color : dictColor)}>
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
                    onChange={(e) => updateColumn(c.name, { displayName: e.target.value })}
                  />
                  {cm.displayName.trim() !== "" && dictValue !== undefined && (
                    <span className="badge badge-warn" title={t("tableEdit.dictValue", { value: dictValue })}>
                      {t("tableEdit.overridesDict")}
                    </span>
                  )}
                </td>
                <td>
                  {/* 共通タグは readonly。ここで消せてしまうと「一律に付ける」が成立しない
                      （個別に消す手段は将来の課題。P-12） */}
                  {commonTags.map((tag) => (
                    <span
                      key={tag}
                      className="badge badge-dict"
                      title={t("tableEdit.commonTag")}
                      data-testid={`column-common-tag-${c.name}`}
                    >
                      {tag}
                    </span>
                  ))}
                  <TagInput
                    value={cm.tags}
                    candidates={tagCandidates}
                    disabled={!sessionReady || saving}
                    compact
                    testId={`column-tags-${c.name}`}
                    onChange={(tags) => updateColumn(c.name, { tags })}
                  />
                </td>
                <td>
                  <ColorSelect
                    value={cm.color}
                    disabled={!sessionReady || saving}
                    testId={`column-color-${c.name}`}
                    onChange={(color) => updateColumn(c.name, { color })}
                  />
                  {cm.color === "" && isColorToken(dictColor) && (
                    <span className="badge badge-dict" title={t("tableEdit.commonColor")}>
                      {t(`color.${dictColor}` as const)}
                    </span>
                  )}
                </td>
                {/* 注記は行内に入力欄を置かずモーダルで書く（複数行で書けるように。P-04） */}
                <td>
                  <NotesCell
                    value={cm.notes}
                    columnName={c.name}
                    onOpen={() => setNotesColumn(c.name)}
                  />
                </td>
              </tr>
            );
          })}
        </ScrollTable>

        {/* ---- 論理制約（P-06 / P-07） ---- */}
        <h3>{t("tableEdit.sectionLogical")}</h3>
        <p className="muted form-hint">ⓘ {t("tableEdit.logicalHint")}</p>

        {/* 一覧は要約に徹し、作成・編集はダイアログで行う（複合キーの対応を読めるように） */}
        <h4>{t("table.logicalUniques")}</h4>
        <ConstraintList empty={draft.logicalUniques.length === 0}>
          {draft.logicalUniques.map((u, i) => (
            <ConstraintRow
              key={u.uid}
              name={u.name}
              autoName={autoNameOf("luk", u.uid, u.columns)}
              detail={u.columns.length > 0 ? u.columns.join(", ") : t("tableEdit.noColumns")}
              hasError={errorsAt(allErrors, `meta.logicalUniques[${i}]`).length > 0}
              testId="logical-unique"
              onEdit={() => setEditing({ kind: "unique", uid: u.uid })}
              onRemove={() =>
                update({ logicalUniques: draft.logicalUniques.filter((x) => x.uid !== u.uid) })
              }
            />
          ))}
        </ConstraintList>
        <button
          type="button"
          className="button-link"
          data-testid="add-logical-unique"
          onClick={() => setEditing({ kind: "unique", uid: null })}
        >
          {t("tableEdit.addLogicalUnique")}
        </button>

        <h4>{t("table.logicalForeignKeys")}</h4>
        <ConstraintList empty={draft.logicalForeignKeys.length === 0}>
          {draft.logicalForeignKeys.map((fk, i) => (
            <ConstraintRow
              key={fk.uid}
              name={fk.name}
              autoName={autoNameOf("lfk", fk.uid, fk.columns)}
              detail={<FkDetail fk={fk} />}
              badge={<CardinalityBadge value={fk.cardinality} />}
              hasError={errorsAt(allErrors, `meta.logicalForeignKeys[${i}]`).length > 0}
              testId="logical-fk"
              onEdit={() => setEditing({ kind: "fk", uid: fk.uid })}
              onRemove={() =>
                update({
                  logicalForeignKeys: draft.logicalForeignKeys.filter((x) => x.uid !== fk.uid),
                })
              }
            />
          ))}
        </ConstraintList>
        <button
          type="button"
          className="button-link"
          data-testid="add-logical-fk"
          onClick={() => setEditing({ kind: "fk", uid: null })}
        >
          {t("tableEdit.addLogicalFk")}
        </button>

        {/* ---- 物理FK（P-11。定義は machine-owned で編集できない。触れるのは多重度と注記だけ） ---- */}
        <PhysicalFkSection
          table={table}
          draft={draft}
          onOpen={(name) => setEditingPhysicalFk(name)}
        />
      </fieldset>

      {notesColumn !== null && (
        <NotesDialog
          columnName={notesColumn}
          value={(draft.columns[notesColumn] ?? EMPTY_COLUMN_DRAFT).notes}
          onClose={() => setNotesColumn(null)}
          onSubmit={(notes) => {
            updateColumn(notesColumn, { notes });
            setNotesColumn(null);
          }}
        />
      )}

      {editing?.kind === "unique" && (
        <LogicalUniqueDialog
          table={table}
          initial={draft.logicalUniques.find((x) => x.uid === editing.uid) ?? null}
          taken={takenNames("unique", editing.uid)}
          onClose={() => setEditing(null)}
          onSubmit={(next) => {
            update({ logicalUniques: upsert(draft.logicalUniques, next) });
            setEditing(null);
          }}
        />
      )}
      {editing?.kind === "fk" && (
        <LogicalFkDialog
          table={table}
          initial={draft.logicalForeignKeys.find((x) => x.uid === editing.uid) ?? null}
          taken={takenNames("fk", editing.uid)}
          onClose={() => setEditing(null)}
          onSubmit={(next) => {
            update({ logicalForeignKeys: upsert(draft.logicalForeignKeys, next) });
            setEditing(null);
          }}
        />
      )}

      {editingPhysicalFk !== null &&
        (() => {
          const fk = (table.foreignKeys ?? []).find((f) => f.name === editingPhysicalFk);
          if (fk === undefined) return null;
          return (
            <PhysicalFkDialog
              table={table}
              fk={fk}
              initial={draft.physicalCardinality[editingPhysicalFk] ?? { ...EMPTY_CARDINALITY }}
              onClose={() => setEditingPhysicalFk(null)}
              onSubmit={(cardinality) => {
                update({
                  physicalCardinality: {
                    ...draft.physicalCardinality,
                    [editingPhysicalFk]: cardinality,
                  },
                });
                setEditingPhysicalFk(null);
              }}
            />
          );
        })()}

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

/**
 * 物理FK の一覧（P-11）。DB から読み取った定義そのものは編集できない（machine-owned）。
 * ここは**カーディナリティの上書きと注記への入口**であり、設定はそれぞれの詳細ダイアログで行う。
 * 名前の無い物理FK は `meta.relations` のキーを作れないため、設定の対象にできない。
 */
function PhysicalFkSection({
  table,
  draft,
  onOpen,
}: {
  table: Table;
  draft: MetaDraft;
  onOpen: (name: string) => void;
}) {
  const { t } = useI18n();
  const named = (table.foreignKeys ?? []).filter((fk) => fk.name !== undefined);
  const unnamed = (table.foreignKeys ?? []).length - named.length;
  if (named.length === 0 && unnamed === 0) return null;

  return (
    <>
      <h3>{t("tableEdit.sectionPhysicalFk")}</h3>
      <p className="muted form-hint">ⓘ {t("tableEdit.physicalFkSectionHint")}</p>
      <ConstraintList empty={named.length === 0}>
        {named.map((fk) => {
          const name = fk.name as string;
          const cardinality = draft.physicalCardinality[name] ?? EMPTY_CARDINALITY;
          return (
            <ConstraintRow
              key={name}
              name={name}
              detail={
                <FkDetail
                  fk={{
                    uid: 0,
                    name,
                    columns: fk.columns,
                    refTable: fk.ref.table,
                    refColumns: fk.ref.columns ?? [],
                    notes: "",
                    cardinality,
                  }}
                />
              }
              badge={<CardinalityBadge value={cardinality} />}
              hasError={false}
              editLabel={t("tableEdit.openDetail")}
              testId="physical-fk"
              onEdit={() => onOpen(name)}
            />
          );
        })}
      </ConstraintList>
      {unnamed > 0 && <p className="muted form-hint">{t("tableEdit.physicalFkUnnamed", { n: unnamed })}</p>}
    </>
  );
}
