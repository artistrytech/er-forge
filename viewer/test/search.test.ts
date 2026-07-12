import { describe, expect, it } from "vitest";
import { searchAll } from "../src/model/search";
import type { Dictionary, IndexData, Table } from "../src/model/types";

const index: IndexData = {
  tables: [
    { id: "public.users", name: "users", displayName: "ユーザー", tags: ["auth"] },
    { id: "public.orders", name: "orders", displayName: "注文" },
  ],
  relations: [],
};

const usersTable = {
  id: "public.users",
  name: "users",
  columns: [
    { name: "email", comment: "メールアドレス" },
    { name: "created_at" },
  ],
  meta: { columns: { email: { displayName: "メール" } } },
} as unknown as Table;

const dict: Dictionary = { columns: { created_at: "作成日時" } };

describe("searchAll (F-01 / F-04)", () => {
  it("テーブル論理名でヒットする", () => {
    const hits = searchAll("ユーザー", index, {}, dict);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.tableId).toBe("public.users");
    expect(hits[0]?.tableMatched).toBe(true);
  });
  it("タグでヒットする", () => {
    expect(searchAll("auth", index, {}, dict)).toHaveLength(1);
  });
  it("未ロードのテーブルはカラム検索の対象にならない（F-04）", () => {
    expect(searchAll("email", index, {}, dict)).toHaveLength(0);
  });
  it("ロード済みならカラム名・論理名・コメントでヒットする", () => {
    const loaded = { "public.users": usersTable };
    expect(searchAll("email", index, loaded, dict)[0]?.columnHits[0]?.column).toBe("email");
    expect(searchAll("メール", index, loaded, dict)[0]?.columnHits[0]?.column).toBe("email");
    expect(searchAll("作成日時", index, loaded, dict)[0]?.columnHits[0]?.column).toBe(
      "created_at",
    );
  });
  it("大文字小文字を区別しない", () => {
    expect(searchAll("USERS", index, {}, dict)).toHaveLength(1);
  });
  it("空クエリは空結果", () => {
    expect(searchAll("  ", index, {}, dict)).toHaveLength(0);
  });
});
