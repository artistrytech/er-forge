/**
 * テーブル編集画面（O-03 / J-05）のフォーム状態と meta への変換。
 *
 * - draft は committed のディープコピーから開始する（O-03 詳細設計 §1.2）
 * - 行には画面内でのみ有効な uid を振る（§1.3。ファイルには保存しない）
 * - 空文字は「未設定」= キー削除として meta から落とす（P 詳細設計 §1.1）
 * - meta の未知キー（前方互換）は変換時に引き継ぐ
 */
import { normalizeTags } from "./metaRules";
import type { CardEnd, Table, TableMeta } from "./types";

export interface DraftColumnMeta {
  displayName: string;
  /** タグ（P-12）。確定済みのタグのみを持つ（入力中の文字列は TagInput 側） */
  tags: string[];
  /** 色トークン（P-13）。"" は未設定。タグとは独立 */
  color: string;
  notes: string;
}

export interface DraftLogicalUnique {
  uid: number;
  name: string;
  columns: string[];
  notes: string;
}

export interface DraftLogicalFk {
  uid: number;
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  notes: string;
}

export interface DraftRelation {
  parent: "" | CardEnd;
  child: "" | CardEnd;
  notes: string;
}

export interface MetaDraft {
  displayName: string;
  tags: string[];
  /** 色トークン（P-13）。"" は未設定 */
  color: string;
  notes: string;
  columns: Record<string, DraftColumnMeta>;
  logicalUniques: DraftLogicalUnique[];
  logicalForeignKeys: DraftLogicalFk[];
  /** キー = `fk:<制約名>` / `lfk:<制約名>`（P-11） */
  relations: Record<string, DraftRelation>;
}

let uidSeq = 0;
export function newUid(): number {
  return ++uidSeq;
}

export function buildDraft(table: Table): MetaDraft {
  const meta = table.meta;
  const columns: Record<string, DraftColumnMeta> = {};
  for (const c of table.columns) {
    const cm = meta?.columns?.[c.name];
    columns[c.name] = {
      displayName: cm?.displayName ?? "",
      tags: [...(cm?.tags ?? [])],
      color: cm?.color ?? "",
      notes: cm?.notes ?? "",
    };
  }
  const relations: Record<string, DraftRelation> = {};
  for (const [key, rm] of Object.entries(meta?.relations ?? {})) {
    relations[key] = { parent: rm.parent ?? "", child: rm.child ?? "", notes: rm.notes ?? "" };
  }
  return {
    displayName: meta?.displayName ?? "",
    tags: [...(meta?.tags ?? [])],
    color: meta?.color ?? "",
    notes: meta?.notes ?? "",
    columns,
    logicalUniques: (meta?.logicalUniques ?? []).map((u) => ({
      uid: newUid(),
      name: u.name ?? "",
      columns: [...u.columns],
      notes: u.notes ?? "",
    })),
    logicalForeignKeys: (meta?.logicalForeignKeys ?? []).map((fk) => ({
      uid: newUid(),
      name: fk.name ?? "",
      columns: [...fk.columns],
      refTable: fk.ref.table,
      refColumns: [...(fk.ref.columns ?? [])],
      notes: fk.notes ?? "",
    })),
    relations,
  };
}

/** 制約名の自動生成（P 詳細設計 §4.1）。既存名と衝突したら連番を付ける */
export function generateConstraintName(
  prefix: "luk" | "lfk",
  tableName: string,
  columns: string[],
  taken: ReadonlySet<string>,
): string {
  const base = `${prefix}_${tableName}_${columns.join("_")}`.slice(0, 60);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * draft → meta（保存ペイロード）。空値のキーは削除し、未知キーは元の meta から引き継ぐ。
 * 制約名が空の行には名前を自動生成する。
 */
export function draftToMeta(draft: MetaDraft, table: Table): TableMeta {
  const original = (table.meta ?? {}) as Record<string, unknown>;
  const meta: Record<string, unknown> = {};
  // 未知キー（前方互換）を先に引き継ぐ。既知キーはこの後の代入 / delete が上書きする
  for (const [k, v] of Object.entries(original)) {
    meta[k] = v;
  }
  const known = [
    "displayName",
    "tags",
    "color",
    "notes",
    "columns",
    "logicalUniques",
    "logicalForeignKeys",
    "relations",
  ];
  for (const k of known) {
    delete meta[k];
  }

  const displayName = draft.displayName.trim();
  if (displayName !== "") meta["displayName"] = displayName;

  // タグはサーバーと同じ規則で正規化してから送る（P-12）
  const tags = normalizeTags(draft.tags);
  if (tags.length > 0) meta["tags"] = tags;

  if (draft.color !== "") meta["color"] = draft.color;

  const notes = draft.notes.trim();
  if (notes !== "") meta["notes"] = notes;

  type ColumnEntry = { displayName?: string; tags?: string[]; color?: string; notes?: string };
  const columns: Record<string, ColumnEntry> = {};
  for (const [name, cm] of Object.entries(draft.columns)) {
    const entry: ColumnEntry = {};
    if (cm.displayName.trim() !== "") entry.displayName = cm.displayName.trim();
    const columnTags = normalizeTags(cm.tags);
    if (columnTags.length > 0) entry.tags = columnTags;
    if (cm.color !== "") entry.color = cm.color;
    if (cm.notes.trim() !== "") entry.notes = cm.notes.trim();
    if (Object.keys(entry).length > 0) columns[name] = entry;
  }
  if (Object.keys(columns).length > 0) meta["columns"] = columns;

  const taken = new Set<string>();
  for (const u of draft.logicalUniques) {
    if (u.name.trim() !== "") taken.add(u.name.trim());
  }
  const logicalUniques = draft.logicalUniques.map((u) => {
    const name =
      u.name.trim() !== ""
        ? u.name.trim()
        : generateConstraintName("luk", table.name, u.columns, taken);
    taken.add(name);
    return {
      name,
      columns: [...u.columns],
      ...(u.notes.trim() !== "" ? { notes: u.notes.trim() } : {}),
    };
  });
  if (logicalUniques.length > 0) meta["logicalUniques"] = logicalUniques;

  const takenFk = new Set<string>();
  for (const fk of draft.logicalForeignKeys) {
    if (fk.name.trim() !== "") takenFk.add(fk.name.trim());
  }
  const logicalForeignKeys = draft.logicalForeignKeys.map((fk) => {
    const name =
      fk.name.trim() !== ""
        ? fk.name.trim()
        : generateConstraintName("lfk", table.name, fk.columns, takenFk);
    takenFk.add(name);
    return {
      name,
      columns: [...fk.columns],
      ref: { table: fk.refTable, columns: [...fk.refColumns] },
      ...(fk.notes.trim() !== "" ? { notes: fk.notes.trim() } : {}),
    };
  });
  if (logicalForeignKeys.length > 0) meta["logicalForeignKeys"] = logicalForeignKeys;

  const relations: Record<string, { parent?: CardEnd; child?: CardEnd; notes?: string }> = {};
  for (const [key, r] of Object.entries(draft.relations)) {
    const entry: { parent?: CardEnd; child?: CardEnd; notes?: string } = {};
    if (r.parent !== "") entry.parent = r.parent;
    if (r.child !== "") entry.child = r.child;
    if (r.notes.trim() !== "") entry.notes = r.notes.trim();
    if (Object.keys(entry).length > 0) relations[key] = entry;
  }
  if (Object.keys(relations).length > 0) meta["relations"] = relations;

  return meta as TableMeta;
}

// ------------------------------------------------------ バリデーション（J-06 / P-08）

export interface FieldError {
  /** サーバーの 422 と同じパス形式（例: meta.logicalForeignKeys[0].ref.table） */
  path: string;
  code:
    | "DUPLICATE"
    | "EMPTY_COLUMNS"
    | "COLUMN_NOT_FOUND"
    | "REF_TABLE_REQUIRED"
    | "REF_TABLE_NOT_FOUND"
    | "REF_COLUMN_NOT_FOUND"
    | "COUNT_MISMATCH";
  /** メッセージ変数（{name} など） */
  params?: Record<string, string>;
}

/**
 * 保存前のクライアント検証。サーバー（TableService）の V-1〜V-5 と同じ判定。
 * 参照先テーブルのカラム検証は、そのテーブルが読み込み済みの場合のみ行う
 * （未読なら保存時にサーバーが検証する）。
 */
export function validateDraft(
  draft: MetaDraft,
  table: Table,
  existingTableIds: ReadonlySet<string>,
  loadedTables: Readonly<Record<string, Table | undefined>>,
): FieldError[] {
  const errors: FieldError[] = [];
  const own = new Set(table.columns.map((c) => c.name));

  const luNames = new Set<string>();
  draft.logicalUniques.forEach((u, i) => {
    const path = `meta.logicalUniques[${i}]`;
    const name = u.name.trim();
    if (name !== "") {
      if (luNames.has(name)) errors.push({ path: `${path}.name`, code: "DUPLICATE", params: { name } });
      luNames.add(name);
    }
    if (u.columns.length === 0) {
      errors.push({ path: `${path}.columns`, code: "EMPTY_COLUMNS" });
    }
    for (const col of u.columns) {
      if (!own.has(col)) {
        errors.push({ path: `${path}.columns`, code: "COLUMN_NOT_FOUND", params: { name: col } });
      }
    }
  });

  const fkNames = new Set<string>();
  draft.logicalForeignKeys.forEach((fk, i) => {
    const path = `meta.logicalForeignKeys[${i}]`;
    const name = fk.name.trim();
    if (name !== "") {
      if (fkNames.has(name)) errors.push({ path: `${path}.name`, code: "DUPLICATE", params: { name } });
      fkNames.add(name);
    }
    if (fk.columns.length === 0) {
      errors.push({ path: `${path}.columns`, code: "EMPTY_COLUMNS" });
    }
    for (const col of fk.columns) {
      if (!own.has(col)) {
        errors.push({ path: `${path}.columns`, code: "COLUMN_NOT_FOUND", params: { name: col } });
      }
    }
    if (fk.refTable === "") {
      errors.push({ path: `${path}.ref.table`, code: "REF_TABLE_REQUIRED" });
      return;
    }
    if (!existingTableIds.has(fk.refTable)) {
      errors.push({ path: `${path}.ref.table`, code: "REF_TABLE_NOT_FOUND", params: { name: fk.refTable } });
      return;
    }
    if (fk.refColumns.length === 0) {
      errors.push({ path: `${path}.ref.columns`, code: "EMPTY_COLUMNS" });
      return;
    }
    if (fk.columns.length !== fk.refColumns.length) {
      errors.push({ path: `${path}.ref.columns`, code: "COUNT_MISMATCH" });
    }
    const target = fk.refTable === table.id ? table : loadedTables[fk.refTable];
    if (target) {
      const targetCols = new Set(target.columns.map((c) => c.name));
      for (const col of fk.refColumns) {
        if (!targetCols.has(col)) {
          errors.push({
            path: `${path}.ref.columns`,
            code: "REF_COLUMN_NOT_FOUND",
            params: { name: `${fk.refTable}.${col}` },
          });
        }
      }
    }
  });

  return errors;
}

/** path の前方一致でフィールドのエラーを引く（サーバー 422 のエラーにも使う） */
export function errorsAt(errors: { path: string }[], prefix: string): { path: string }[] {
  return errors.filter((e) => e.path === prefix || e.path.startsWith(prefix + "."));
}
