/**
 * テーブル編集フォーム（O-03 / J-05）のドラフト変換とバリデーション。
 * P 詳細設計 §1.1（空 = キー削除）/ §4.1（名前の自動生成）/ Phase0 V-4（未知キーの保持）。
 */
import { describe, expect, it } from "vitest";
import {
  buildDraft,
  draftToMeta,
  generateConstraintName,
  validateDraft,
} from "../src/model/metaDraft";
import type { Table } from "../src/model/types";

const users: Table = {
  id: "public.users",
  name: "users",
  schema: "public",
  columns: [
    { name: "id", type: "int4", logicalType: "int", nullable: false },
    { name: "email", type: "varchar(255)", logicalType: "string", nullable: false },
    { name: "org_id", type: "int4", logicalType: "int", nullable: true },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "users_org_fk", columns: ["org_id"], ref: { table: "public.orgs", columns: ["id"] } },
  ],
  meta: {
    displayName: "ユーザー",
    columns: { org_id: { displayName: "所属組織ID" } },
    // 前方互換の未知キー
    futureKey: { x: 1 },
  } as Table["meta"],
};

describe("buildDraft / draftToMeta", () => {
  it("往復で meta が保たれる（未知キーも）", () => {
    const draft = buildDraft(users);
    const meta = draftToMeta(draft, users) as Record<string, unknown>;
    expect(meta["displayName"]).toBe("ユーザー");
    expect(meta["columns"]).toEqual({ org_id: { displayName: "所属組織ID" } });
    expect(meta["futureKey"]).toEqual({ x: 1 });
  });

  it("空文字は「未設定」= キー削除（P §1.1）", () => {
    const draft = buildDraft(users);
    draft.displayName = "  ";
    draft.columns["org_id"] = { displayName: "", tags: [], color: "", notes: "" };
    const meta = draftToMeta(draft, users) as Record<string, unknown>;
    expect(meta["displayName"]).toBeUndefined();
    expect(meta["columns"]).toBeUndefined();
  });

  it("タグは正規化される（前後空白・空要素・大小無視の重複を落とす。P-12）", () => {
    const draft = buildDraft(users);
    draft.tags = [" core ", "auth", "Core", "", "廃止"];
    const meta = draftToMeta(draft, users) as Record<string, unknown>;
    expect(meta["tags"]).toEqual(["core", "auth", "廃止"]);
  });

  it("色とカラムのタグ・色が保存される。未設定はキーごと落ちる（P-12 / P-13）", () => {
    const draft = buildDraft(users);
    draft.color = "muted";
    draft.columns["org_id"] = {
      displayName: "",
      tags: ["pii"],
      color: "red",
      notes: "",
    };
    draft.columns["email"] = { displayName: "", tags: [], color: "", notes: "" };
    const meta = draftToMeta(draft, users) as Record<string, unknown>;
    expect(meta["color"]).toBe("muted");
    expect(meta["columns"]).toEqual({ org_id: { tags: ["pii"], color: "red" } });
  });

  it("制約名が空なら自動生成され、テーブル内で一意になる", () => {
    const draft = buildDraft(users);
    draft.logicalUniques = [
      { uid: 1, name: "", columns: ["org_id", "email"], notes: "" },
      { uid: 2, name: "", columns: ["org_id", "email"], notes: "" },
    ];
    const meta = draftToMeta(draft, users) as {
      logicalUniques: { name: string }[];
    };
    expect(meta.logicalUniques[0]!.name).toBe("luk_users_org_id_email");
    expect(meta.logicalUniques[1]!.name).toBe("luk_users_org_id_email_2");
  });

  it("カーディナリティの部分上書き（child のみ）が保存される（P-11）", () => {
    const draft = buildDraft(users);
    draft.relations["fk:users_org_fk"] = { parent: "", child: "1..N", notes: "必ず1人以上" };
    const meta = draftToMeta(draft, users) as Record<string, unknown>;
    expect(meta["relations"]).toEqual({
      "fk:users_org_fk": { child: "1..N", notes: "必ず1人以上" },
    });
  });
});

describe("generateConstraintName", () => {
  it("衝突したら連番を付ける", () => {
    const taken = new Set(["lfk_users_org_id"]);
    expect(generateConstraintName("lfk", "users", ["org_id"], taken)).toBe("lfk_users_org_id_2");
  });
});

describe("validateDraft（J-06 / P-08 のクライアント側）", () => {
  const tableIds = new Set(["public.users", "public.orders"]);
  const orders: Table = {
    id: "public.orders",
    name: "orders",
    columns: [{ name: "id", type: "int4", logicalType: "int", nullable: false }],
  };

  it("正しい論理外部制約は通る", () => {
    const draft = buildDraft(users);
    draft.logicalForeignKeys = [
      {
        uid: 1,
        name: "",
        columns: ["org_id"],
        refTable: "public.orders",
        refColumns: ["id"],
        notes: "",
      },
    ];
    expect(validateDraft(draft, users, tableIds, { "public.orders": orders })).toEqual([]);
  });

  it("参照先未選択・存在しないカラム・カラム数不一致を検出する", () => {
    const draft = buildDraft(users);
    draft.logicalForeignKeys = [
      { uid: 1, name: "a", columns: ["nope"], refTable: "", refColumns: [], notes: "" },
      {
        uid: 2,
        name: "b",
        columns: ["org_id", "email"],
        refTable: "public.orders",
        refColumns: ["id"],
        notes: "",
      },
    ];
    const errors = validateDraft(draft, users, tableIds, { "public.orders": orders });
    expect(errors.some((e) => e.code === "COLUMN_NOT_FOUND")).toBe(true);
    expect(errors.some((e) => e.code === "REF_TABLE_REQUIRED")).toBe(true);
    expect(errors.some((e) => e.code === "COUNT_MISMATCH")).toBe(true);
  });

  it("参照先テーブルが未ロードなら参照先カラムの検証はスキップされる（保存時にサーバーが検証）", () => {
    const draft = buildDraft(users);
    draft.logicalForeignKeys = [
      {
        uid: 1,
        name: "a",
        columns: ["org_id"],
        refTable: "public.orders",
        refColumns: ["mystery"],
        notes: "",
      },
    ];
    expect(validateDraft(draft, users, tableIds, {})).toEqual([]);
  });

  it("名前の重複を検出する（V-1）", () => {
    const draft = buildDraft(users);
    draft.logicalUniques = [
      { uid: 1, name: "luk_a", columns: ["email"], notes: "" },
      { uid: 2, name: "luk_a", columns: ["org_id"], notes: "" },
    ];
    const errors = validateDraft(draft, users, tableIds, {});
    expect(errors.some((e) => e.code === "DUPLICATE")).toBe(true);
  });
});
