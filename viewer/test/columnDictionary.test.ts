/** カラム論理名の一括編集画面（P-03）の行集合の計算。 */
import { describe, expect, it } from "vitest";
import { aggregateColumns, parseTsvPairs } from "../src/model/columnDictionary";
import type { Table } from "../src/model/types";

const users: Table = {
  id: "public.users",
  name: "users",
  columns: [
    { name: "id" },
    { name: "created_at" },
    { name: "org_id" },
  ],
  meta: { columns: { org_id: { displayName: "所属組織ID" } } },
};

const orders: Table = {
  id: "public.orders",
  name: "orders",
  columns: [{ name: "id" }, { name: "created_at" }],
};

describe("aggregateColumns", () => {
  it("distinct なカラム名 + 出現数 + 個別設定の集計（§2.2 / §2.3）", () => {
    const rows = aggregateColumns([users, orders], { created_at: "作成日時" });
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("id")?.occurrences).toBe(2);
    expect(byName.get("created_at")?.occurrences).toBe(2);
    expect(byName.get("org_id")?.occurrences).toBe(1);
    expect(byName.get("org_id")?.overrides).toEqual(["public.users"]);
  });

  it("辞書にしか無いキーは「出現 0」の孤立エントリとして残る（自動削除しない）", () => {
    const rows = aggregateColumns([users], { legacy_flag: "旧フラグ" });
    const orphan = rows.find((r) => r.name === "legacy_flag");
    expect(orphan).toBeDefined();
    expect(orphan?.occurrences).toBe(0);
  });

  it("出現数の降順 → 名前の昇順でソートされる", () => {
    const rows = aggregateColumns([users, orders], {});
    expect(rows.map((r) => r.name)).toEqual(["created_at", "id", "org_id"]);
  });
});

describe("parseTsvPairs（一括貼り付け）", () => {
  it("タブ区切り行を組に変換し、タブ無し・物理名空の行は捨てる", () => {
    const pairs = parseTsvPairs("created_at\t作成日時\nメモ行\n\tX\nupdated_at\t更新日時\r\nid\t");
    expect(pairs).toEqual([
      ["created_at", "作成日時"],
      ["updated_at", "更新日時"],
      ["id", ""], // 空 = 削除の意思として保持する
    ]);
  });
});
