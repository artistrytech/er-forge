/**
 * スキーマ情報の JSON 書き出し（ツールメニュー）の組み立て。
 * 「何を入れて何を入れないか」「辞書の畳み方」「整形しない」ことを固定する。
 */
import { describe, expect, it } from "vitest";
import {
  buildSchemaExport,
  schemaExportFileName,
  serializeSchemaExport,
  type SchemaExportInput,
} from "../src/model/schemaExport";
import type { Table } from "../src/model/types";

function table(id: string, extra: Partial<Table> = {}): Table {
  return {
    id,
    name: id.split(".")[1] ?? id,
    columns: [{ name: "id" }, { name: "email" }],
    ...extra,
  } as Table;
}

function input(over: Partial<SchemaExportInput> = {}): SchemaExportInput {
  return {
    manifest: {
      schemaVersion: 1,
      tables: {
        "public.users": "schema/public/users.js",
        "public.orders": "schema/public/orders.js",
      },
      diagrams: [{ id: "core", file: "diagrams/core.js", title: "コア", order: 1 }],
    },
    index: {
      tables: [{ id: "public.users", name: "users", diagrams: ["core"] }],
      relations: [
        {
          id: "public.orders#fk:orders_user_id_fkey",
          kind: "physical",
          from: "public.orders",
          to: "public.users",
        },
      ],
      tagsUsed: ["master"],
    },
    dictionary: {
      columns: {
        id: { displayName: "ID" },
        email: { displayName: "メールアドレス", tags: ["pii"], color: "amber" },
      },
    },
    tables: {
      "public.users": table("public.users", {
        meta: {
          displayName: "ユーザー",
          notes: "注記",
          columns: { email: { displayName: "ログインID", tags: ["ログイン"] } },
        },
      }),
      "public.orders": table("public.orders"),
    },
    ...over,
  };
}

describe("buildSchemaExport", () => {
  it("テーブルは manifest のキー順に並ぶ（同じデータなら同じ出力）", () => {
    const { data, missing } = buildSchemaExport(input());
    expect(data.tables.map((t) => t.id)).toEqual(["public.users", "public.orders"]);
    expect(missing).toEqual([]);
  });

  it("テーブルのメタデータとリレーションを含む", () => {
    const { data } = buildSchemaExport(input());
    expect(data.tables[0]?.meta?.displayName).toBe("ユーザー");
    expect(data.tables[0]?.meta?.notes).toBe("注記");
    expect(data.relations).toHaveLength(1);
    expect(data.schemaVersion).toBe(1);
  });

  it("出力は schemaVersion / tables / relations の3つだけ（ページ情報・描画情報・辞書は持たない）", () => {
    const json = serializeSchemaExport(buildSchemaExport(input()).data);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["relations", "schemaVersion", "tables"]);
    // 所属ページ（index.tables[].diagrams）もページ情報なので持ち込まない
    expect(json).not.toContain("core");
    expect(json).not.toContain("diagrams");
  });

  it("辞書のカラム論理名・タグをテーブルの meta.columns へ畳む（色は運ばない）", () => {
    const { data } = buildSchemaExport(input());
    const orders = data.tables.find((t) => t.id === "public.orders");
    expect(orders?.meta?.columns).toEqual({
      id: { displayName: "ID" },
      email: { displayName: "メールアドレス", tags: ["pii"] },
    });
  });

  it("テーブル個別の論理名が辞書より優先され、タグは辞書 ∪ 個別で合成される", () => {
    const { data } = buildSchemaExport(input());
    const users = data.tables.find((t) => t.id === "public.users");
    expect(users?.meta?.columns?.["email"]).toEqual({
      displayName: "ログインID",
      tags: ["pii", "ログイン"],
    });
    // 個別の無いカラムだけ辞書から埋まる
    expect(users?.meta?.columns?.["id"]?.displayName).toBe("ID");
  });

  it("辞書にタグが無いカラムは個別のタグに触らない", () => {
    const { data } = buildSchemaExport(
      input({
        dictionary: { columns: { id: { displayName: "ID" } } },
        tables: {
          "public.users": table("public.users", {
            meta: { columns: { email: { tags: ["ログイン"] } } },
          }),
        },
      }),
    );
    expect(data.tables[0]?.meta?.columns?.["email"]).toEqual({ tags: ["ログイン"] });
  });

  it("辞書にも個別にも無ければ書かない（物理名で埋めない）", () => {
    const { data } = buildSchemaExport(input({ dictionary: null }));
    const orders = data.tables.find((t) => t.id === "public.orders");
    expect(orders?.meta).toBeUndefined();
  });

  it("ストアのテーブルを書き換えない（畳むときは新しいオブジェクトを作る）", () => {
    const src = input();
    const before = JSON.stringify(src.tables);
    buildSchemaExport(src);
    expect(JSON.stringify(src.tables)).toBe(before);
  });

  it("読み込めなかったテーブルは落とし、その ID を返す", () => {
    const { data, missing } = buildSchemaExport(
      input({ tables: { "public.users": table("public.users") } }),
    );
    expect(data.tables.map((t) => t.id)).toEqual(["public.users"]);
    expect(missing).toEqual(["public.orders"]);
  });
});

describe("serializeSchemaExport", () => {
  it("整形しない（改行・インデントを持たない）", () => {
    const json = serializeSchemaExport(buildSchemaExport(input()).data);
    expect(json).not.toContain("\n");
    expect(json).not.toContain("  ");
    expect(json.startsWith("{")).toBe(true);
  });

  it("リレーションが無ければ空配列（キーは落とさない）", () => {
    const json = serializeSchemaExport(buildSchemaExport(input({ index: null })).data);
    expect(JSON.parse(json)).toMatchObject({ relations: [] });
  });
});

describe("schemaExportFileName", () => {
  it("ワークスペース ID を含む", () => {
    expect(schemaExportFileName("sales")).toBe("schema-sales.json");
    expect(schemaExportFileName(null)).toBe("schema-default.json");
  });
});
