/**
 * データファイル ⇔ モデルの境界の型定義（zod）。
 * データ形式は設計書 §5 / Phase0 詳細設計 §1 に従う。
 * 未知キーは捨てない（前方互換。Phase0 §3.3 V-4）ため、すべて looseObject。
 */
import { z } from "zod";

/** ビューアが読めるデータ形式のバージョン（A-04） */
export const SUPPORTED_SCHEMA_VERSION = 1;

export const zCardEnd = z.enum(["0..1", "1..1", "0..N", "1..N"]);
export type CardEnd = z.infer<typeof zCardEnd>;

// ---- workspaces.js（ワークスペースの索引。ツール生成物。§6.1 段階0） ----

export const zWorkspaces = z.looseObject({
  workspaces: z
    .array(z.looseObject({ id: z.string(), name: z.string() }))
    .default([]),
});

// ---- manifest.js ----

export const zManifest = z.looseObject({
  schemaVersion: z.number(),
  generatedAt: z.string().optional(),
  source: z
    .looseObject({ product: z.string().optional(), version: z.string().optional() })
    .optional(),
  config: z.string().optional(),
  dictionary: z.string().optional(),
  tables: z.record(z.string(), z.string()).optional(),
  diagrams: z
    .array(
      z.looseObject({
        id: z.string(),
        file: z.string(),
        title: z.string().optional(),
        order: z.number().optional(),
      }),
    )
    .optional(),
});
export type Manifest = z.infer<typeof zManifest>;
export type DiagramRef = NonNullable<Manifest["diagrams"]>[number];

// ---- index.js ----

export const zIndexTable = z.looseObject({
  id: z.string(),
  name: z.string(),
  schema: z.string().optional(),
  displayName: z.string().optional(),
  columns: z.number().optional(),
  pk: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  /** meta.color（P-13）。ER図はこの索引だけでノードを描くため、色もここに載る */
  color: z.string().optional(),
  diagrams: z.array(z.string()).optional(),
});
export type IndexTable = z.infer<typeof zIndexTable>;

export const zRelation = z.looseObject({
  id: z.string(),
  kind: z.enum(["physical", "logical"]),
  from: z.string(),
  to: z.string(),
  columns: z.array(z.tuple([z.string(), z.string()])).optional(),
  cardinality: z
    .looseObject({ parent: zCardEnd.optional(), child: zCardEnd.optional() })
    .optional(),
  explicit: z.array(z.string()).optional(),
  dangling: z.boolean().optional(),
});
export type Relation = z.infer<typeof zRelation>;

export const zIndexData = z.looseObject({
  tables: z.array(zIndexTable).optional(),
  relations: z.array(zRelation).optional(),
  /** ワークスペースで使用中のタグ（テーブル ∪ カラム）。タグ入力の候補に使う（P-12） */
  tagsUsed: z.array(z.string()).optional(),
});
export type IndexData = z.infer<typeof zIndexData>;

// ---- dictionary.js ----

export const zDictionary = z.looseObject({
  columns: z.record(z.string(), z.string()).optional(),
});
export type Dictionary = z.infer<typeof zDictionary>;

// ---- config.js（プロジェクト設定 / テーブル無視リスト。サーバーモードでのみ読む。§6.1 段階2'） ----

export const zConfig = z.looseObject({
  ignoreTables: z.array(z.string()).optional(),
});
export type Config = z.infer<typeof zConfig>;

// ---- schema/**.js（テーブル1件） ----

export const zColumn = z.looseObject({
  name: z.string(),
  type: z.string().optional(),
  logicalType: z.string().optional(),
  nullable: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  autoIncrement: z.boolean().optional(),
  generated: z.boolean().optional(),
  comment: z.string().optional(),
});
export type Column = z.infer<typeof zColumn>;

export const zRef = z.looseObject({
  table: z.string(),
  columns: z.array(z.string()).optional(),
});
export type Ref = z.infer<typeof zRef>;

export const zUnique = z.looseObject({
  name: z.string().optional(),
  columns: z.array(z.string()),
});
export const zIndexDef = z.looseObject({
  name: z.string().optional(),
  columns: z.array(z.string()),
  unique: z.boolean().optional(),
});
export const zForeignKey = z.looseObject({
  name: z.string().optional(),
  columns: z.array(z.string()),
  ref: zRef,
  onDelete: z.string().optional(),
  onUpdate: z.string().optional(),
});
export type ForeignKey = z.infer<typeof zForeignKey>;

export const zLogicalUnique = z.looseObject({
  name: z.string().optional(),
  columns: z.array(z.string()),
  notes: z.string().optional(),
});
export const zLogicalForeignKey = z.looseObject({
  name: z.string().optional(),
  columns: z.array(z.string()),
  ref: zRef,
  notes: z.string().optional(),
});
export type LogicalForeignKey = z.infer<typeof zLogicalForeignKey>;

export const zRelationMeta = z.looseObject({
  parent: zCardEnd.optional(),
  child: zCardEnd.optional(),
  notes: z.string().optional(),
});
export const zColumnMeta = z.looseObject({
  displayName: z.string().optional(),
  tags: z.array(z.string()).optional(),
  color: z.string().optional(),
  notes: z.string().optional(),
});
export type ColumnMeta = z.infer<typeof zColumnMeta>;

export const zTableMeta = z.looseObject({
  displayName: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** 色（P-13）。タグとは独立した属性で、タグから導出はしない */
  color: z.string().optional(),
  notes: z.string().optional(),
  columns: z.record(z.string(), zColumnMeta).optional(),
  logicalUniques: z.array(zLogicalUnique).optional(),
  logicalForeignKeys: z.array(zLogicalForeignKey).optional(),
  relations: z.record(z.string(), zRelationMeta).optional(),
});
export type TableMeta = z.infer<typeof zTableMeta>;

export const zTable = z.looseObject({
  id: z.string(),
  name: z.string(),
  schema: z.string().optional(),
  comment: z.string().optional(),
  columns: z.array(zColumn),
  primaryKey: z.array(z.string()).optional(),
  uniques: z.array(zUnique).optional(),
  indexes: z.array(zIndexDef).optional(),
  foreignKeys: z.array(zForeignKey).optional(),
  dialect: z.record(z.string(), z.unknown()).optional(),
  meta: zTableMeta.optional(),
});
export type Table = z.infer<typeof zTable>;

// ---- diagrams/**.js（ER図ページ1件） ----

export const zDiagramNode = z.looseObject({
  pos: z.tuple([z.number(), z.number()]),
  w: z.number().optional(),
});
export type DiagramNode = z.infer<typeof zDiagramNode>;

export const zDiagramEdge = z.looseObject({
  waypoints: z.array(z.tuple([z.number(), z.number()])).optional(),
});
export const zDiagram = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  order: z.number().optional(),
  nodes: z.record(z.string(), zDiagramNode).optional(),
  edges: z.record(z.string(), zDiagramEdge).optional(),
});
export type Diagram = z.infer<typeof zDiagram>;

// ---- エッジID（`<テーブルID>#<種別>:<制約名>`。設計書 §5.5） ----

export interface EdgeIdParts {
  tableId: string;
  kind: "fk" | "lfk";
  constraintName: string;
}

export function parseEdgeId(edgeId: string): EdgeIdParts | null {
  const hash = edgeId.indexOf("#");
  if (hash < 0) return null;
  const rest = edgeId.slice(hash + 1);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const kind = rest.slice(0, colon);
  if (kind !== "fk" && kind !== "lfk") return null;
  return { tableId: edgeId.slice(0, hash), kind, constraintName: rest.slice(colon + 1) };
}
