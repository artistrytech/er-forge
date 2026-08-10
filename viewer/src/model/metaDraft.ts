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

/**
 * カーディナリティの上書き（P-11）。"" = 上書きしない（物理からの導出値に任せる）。
 *
 * 保存先は `meta.relations[<種別>:<制約名>]` だが、**ドラフトでは制約名で持たない**。
 * 論理外部制約は編集中に名前が変わる（未入力なら保存時に自動生成される）ため、
 * 名前をキーにすると設定が制約から外れて孤児になってしまう。制約の行そのものに持たせ、
 * 保存時（draftToMeta）に確定した名前でキーを組み立てる。
 */
export interface DraftCardinality {
  parent: "" | CardEnd;
  child: "" | CardEnd;
  notes: string;
}

export const EMPTY_CARDINALITY: DraftCardinality = { parent: "", child: "", notes: "" };

export interface DraftLogicalFk {
  uid: number;
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  /** 制約そのものの注記（meta.logicalForeignKeys[].notes） */
  notes: string;
  /** この制約のカーディナリティ（meta.relations["lfk:<制約名>"]） */
  cardinality: DraftCardinality;
}

/** meta.relations の1エントリ（保存形） */
export type RelationEntry = { parent?: CardEnd; child?: CardEnd; notes?: string };

export interface MetaDraft {
  displayName: string;
  tags: string[];
  /** 色トークン（P-13）。"" は未設定 */
  color: string;
  notes: string;
  columns: Record<string, DraftColumnMeta>;
  logicalUniques: DraftLogicalUnique[];
  logicalForeignKeys: DraftLogicalFk[];
  /**
   * 物理FK のカーディナリティ。キー = 物理FK の制約名（`fk:` は付けない）。
   * 物理FK は machine-owned で編集中に名前が変わらないため、名前で持って問題ない。
   */
  physicalCardinality: Record<string, DraftCardinality>;
  /**
   * 現存する制約に対応しない meta.relations のエントリ（キーは保存形のまま）。
   * 画面には出ないが、保存で黙って捨てない（INV-1。手で書いた設定を消さない）。
   */
  orphanRelations: Record<string, RelationEntry>;
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
  // meta.relations は「どの制約の設定か」で3つに振り分ける（残りは孤児として素通し）
  const rest = new Map<string, RelationEntry>();
  for (const [key, rm] of Object.entries(meta?.relations ?? {})) {
    rest.set(key, {
      ...(rm.parent !== undefined ? { parent: rm.parent } : {}),
      ...(rm.child !== undefined ? { child: rm.child } : {}),
      ...(rm.notes !== undefined ? { notes: rm.notes } : {}),
    });
  }
  const takeCardinality = (key: string): DraftCardinality => {
    const entry = rest.get(key);
    if (entry === undefined) return { ...EMPTY_CARDINALITY };
    rest.delete(key);
    return { parent: entry.parent ?? "", child: entry.child ?? "", notes: entry.notes ?? "" };
  };

  const physicalCardinality: Record<string, DraftCardinality> = {};
  for (const fk of table.foreignKeys ?? []) {
    if (fk.name === undefined) continue; // 名前の無い物理FK は relations のキーを作れない
    physicalCardinality[fk.name] = takeCardinality(`fk:${fk.name}`);
  }
  const logicalForeignKeys = (meta?.logicalForeignKeys ?? []).map((fk) => ({
    uid: newUid(),
    name: fk.name ?? "",
    columns: [...fk.columns],
    refTable: fk.ref.table,
    refColumns: [...(fk.ref.columns ?? [])],
    notes: fk.notes ?? "",
    cardinality: fk.name === undefined ? { ...EMPTY_CARDINALITY } : takeCardinality(`lfk:${fk.name}`),
  }));

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
    logicalForeignKeys,
    physicalCardinality,
    orphanRelations: Object.fromEntries(rest),
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

  // 孤児（現存しない制約への設定）を先に置き、以降のキーが同名なら上書きする
  const relations: Record<string, RelationEntry> = { ...draft.orphanRelations };
  const putCardinality = (key: string, c: DraftCardinality): void => {
    const entry = cardinalityToEntry(c);
    if (entry === null) delete relations[key];
    else relations[key] = entry;
  };
  for (const [name, c] of Object.entries(draft.physicalCardinality)) {
    putCardinality(`fk:${name}`, c);
  }

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
    // カーディナリティのキーは確定した名前で組み立てる（リネームにも自動で追随する）
    putCardinality(`lfk:${name}`, fk.cardinality);
    return {
      name,
      columns: [...fk.columns],
      ref: { table: fk.refTable, columns: [...fk.refColumns] },
      ...(fk.notes.trim() !== "" ? { notes: fk.notes.trim() } : {}),
    };
  });
  if (logicalForeignKeys.length > 0) meta["logicalForeignKeys"] = logicalForeignKeys;

  if (Object.keys(relations).length > 0) meta["relations"] = relations;

  return meta as TableMeta;
}

/** カーディナリティの保存形。すべて未設定なら null（= キーごと落とす。P §1.1） */
export function cardinalityToEntry(c: DraftCardinality): RelationEntry | null {
  const entry: RelationEntry = {};
  if (c.parent !== "") entry.parent = c.parent;
  if (c.child !== "") entry.child = c.child;
  if (c.notes.trim() !== "") entry.notes = c.notes.trim();
  return Object.keys(entry).length > 0 ? entry : null;
}

/** 何も上書きしていないか（一覧の「明示設定あり」バッジの判定） */
export function isAutoCardinality(c: DraftCardinality | undefined): boolean {
  return c === undefined || (c.parent === "" && c.child === "" && c.notes.trim() === "");
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
