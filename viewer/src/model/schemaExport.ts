/**
 * 全スキーマ情報の JSON 書き出し（ツールメニュー）。
 *
 * 手元に読み込み済みのデータだけで組み立てるため、**静的モードでもそのまま使える**
 * （サーバー API は経由しない）。
 *
 * 入れるもの: テーブル定義そのもの（カラム・キー・インデックス・定義SQL・方言情報）と、
 * 人が書いたメタデータ（論理名・タグ・色・注記・論理制約 = `meta`）、リレーション。
 *
 * 入れないもの: ページ情報（manifest.diagrams）と ER図の描画情報（diagrams/**.js の座標）。
 * これらは「どう見せるか」であってスキーマではない。同じ理由で、index.js のうち
 * 所属ページ（`tables[].diagrams`）を含む索引側のテーブル情報も持ち込まない
 * （テーブルの実体は schema/**.js 側を丸ごと入れているので、索引は要らない）。
 *
 * カラム辞書は**独立したキーとしては出さず、テーブル側へ畳んでから出す**（下の
 * `withDictionaryMeta`）。受け取る側に「個別 → 辞書」の解決規則を持たせないため。
 * 畳むのは論理名とタグで、色（表示のための属性）は運ばない。
 */
import { resolveColumnName, resolveColumnTags } from "./logicalName";
import { SUPPORTED_SCHEMA_VERSION } from "./types";
import type { ColumnMeta, Dictionary, IndexData, Manifest, Relation, Table } from "./types";
import { DEFAULT_WORKSPACE_ID } from "./workspace";

export interface SchemaExportInput {
  manifest: Manifest | null;
  index: IndexData | null;
  dictionary: Dictionary | null;
  tables: Record<string, Table>;
}

export interface SchemaExport {
  /** データ形式の版（manifest 由来）。読み手が形を判定できるようにする */
  schemaVersion: number;
  tables: Table[];
  relations: Relation[];
}

export interface SchemaExportResult {
  data: SchemaExport;
  /** manifest にはあるが手元に無い（読み込みに失敗した）テーブル。書き出しからは落ちる */
  missing: string[];
}

/**
 * 書き出す JSON を組み立てる。テーブルの並びは manifest のキー順
 * （＝サーバーの決定論的プリンタが決めた順）にそろえ、同じデータなら同じ出力になるようにする。
 */
export function buildSchemaExport(input: SchemaExportInput): SchemaExportResult {
  const tables: Table[] = [];
  const missing: string[] = [];
  for (const id of Object.keys(input.manifest?.tables ?? {})) {
    const table = input.tables[id];
    if (table === undefined) missing.push(id);
    else tables.push(withDictionaryMeta(table, input.dictionary));
  }

  return {
    data: {
      schemaVersion: input.manifest?.schemaVersion ?? SUPPORTED_SCHEMA_VERSION,
      tables,
      relations: input.index?.relations ?? [],
    },
    missing,
  };
}

/**
 * 辞書由来のカラム論理名・タグを `meta.columns[<カラム>]` へ畳んだテーブルを返す。
 *
 * 解決は logicalName.ts に任せる（規則を二重に書かない。P 詳細設計 INV-1）。属性ごとに
 * 合わせ方が違うため、畳む条件もそれに従う:
 *
 * - 論理名は「個別 → 辞書」の上書きなので、書き込むのは**辞書から解決されたときだけ**。
 *   物理名へのフォールバックは書かない（欠落 = 未設定というデータ形式の意味を保つ）
 * - タグは「辞書 ∪ 個別」の合成なので、**辞書側にタグがあるときだけ**合成結果で置き換える
 *   （辞書が絡まないカラムは元の並びのまま触らない）
 *
 * 畳む必要が無ければ元のオブジェクトをそのまま返す。ストアが持つテーブルは画面が参照して
 * いるため、変更するときは必ず新しいオブジェクトを作る（破壊的変更をしない）。
 */
function withDictionaryMeta(table: Table, dictionary: Dictionary | null): Table {
  let columns: Record<string, ColumnMeta> | undefined;
  const fold = (column: string, patch: Partial<ColumnMeta>): void => {
    columns ??= { ...(table.meta?.columns ?? {}) };
    columns[column] = { ...columns[column], ...patch };
  };

  for (const { name } of table.columns) {
    const resolved = resolveColumnName(table, name, dictionary);
    if (resolved.source === "dictionary") fold(name, { displayName: resolved.name });
    const tags = resolveColumnTags(table, name, dictionary);
    if (tags.dictionary.length > 0) fold(name, { tags: tags.tags });
  }

  if (columns === undefined) return table;
  return { ...table, meta: { ...table.meta, columns } };
}

/**
 * 出力は**整形しない**（最小サイズ）。人が読むためではなく、他のツールに渡すための形。
 * 読みたいときは受け取った側で整形すればよい。
 */
export function serializeSchemaExport(data: SchemaExport): string {
  return JSON.stringify(data);
}

/** 保存ファイル名。ワークスペースIDは英数・ハイフン・アンダーバーのみなのでそのまま使える */
export function schemaExportFileName(workspaceId: string | null): string {
  return `schema-${workspaceId ?? DEFAULT_WORKSPACE_ID}.json`;
}
