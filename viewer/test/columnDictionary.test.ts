/** カラム辞書の画面（P-03）の行集合の計算。 */
import { describe, expect, it } from "vitest";
import {
  aggregateColumns,
  applyPastedRow,
  isEmptyDraft,
  parseTsvRows,
} from "../src/model/columnDictionary";
import type { Dictionary, Table } from "../src/model/types";

const users: Table = {
  id: "public.users",
  name: "users",
  columns: [
    { name: "id" },
    { name: "created_at" },
    { name: "org_id" },
  ],
  meta: {
    columns: {
      org_id: { displayName: "所属組織ID" },
      created_at: { color: "red" },
    },
  },
};

const orders: Table = {
  id: "public.orders",
  name: "orders",
  columns: [{ name: "id" }, { name: "created_at" }],
};

const dict = (columns: Dictionary["columns"]): Dictionary => ({ columns });

describe("aggregateColumns", () => {
  it("distinct なカラム名 + 出現数 + 個別設定の集計（§2.2 / §2.3）", () => {
    const rows = aggregateColumns([users, orders], dict({ created_at: { displayName: "作成日時" } }));
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("id")?.occurrences).toBe(2);
    expect(byName.get("created_at")?.occurrences).toBe(2);
    expect(byName.get("org_id")?.occurrences).toBe(1);
    expect(byName.get("org_id")?.nameOverrides).toEqual(["public.users"]);
  });

  it("論理名だけでなく色・タグの個別設定も「個別設定あり」として拾う", () => {
    const rows = aggregateColumns([users, orders], null);
    const created = rows.find((r) => r.name === "created_at");
    expect(created?.overrides).toEqual([
      { tableId: "public.users", displayName: undefined, color: "red", tags: [] },
    ]);
    // 色だけの個別設定は論理名の上書きではない
    expect(created?.nameOverrides).toEqual([]);
  });

  it("辞書にしか無いキーは「出現 0」の孤立エントリとして残る（自動削除しない）", () => {
    const rows = aggregateColumns([users], dict({ legacy_flag: { displayName: "旧フラグ" } }));
    const orphan = rows.find((r) => r.name === "legacy_flag");
    expect(orphan).toBeDefined();
    expect(orphan?.occurrences).toBe(0);
  });

  it("タグ・色だけのエントリも行として残る（論理名が無くても未設定ではない）", () => {
    const rows = aggregateColumns([], dict({ deleted_at: { tags: ["廃止"] } }));
    expect(rows.map((r) => r.name)).toEqual(["deleted_at"]);
  });

  it("出現数の降順 → 名前の昇順でソートされる", () => {
    const rows = aggregateColumns([users, orders], null);
    expect(rows.map((r) => r.name)).toEqual(["created_at", "id", "org_id"]);
  });
});

describe("isEmptyDraft", () => {
  it("全フィールドが空のときだけ「未設定」= 削除対象", () => {
    expect(isEmptyDraft({ displayName: "", tags: [], color: "" })).toBe(true);
    expect(isEmptyDraft({ displayName: "  ", tags: [], color: "" })).toBe(true);
    expect(isEmptyDraft({ displayName: "", tags: ["pii"], color: "" })).toBe(false);
    expect(isEmptyDraft({ displayName: "", tags: [], color: "red" })).toBe(false);
  });
});

describe("parseTsvRows（一括貼り付け）", () => {
  it("タブ区切り行を解釈し、タブ無し・物理名空の行は捨てる", () => {
    const rows = parseTsvRows("created_at\t作成日時\nメモ行\n\tX\nupdated_at\t更新日時\r\nid\t");
    expect(rows).toEqual([
      { name: "created_at", displayName: "作成日時" },
      { name: "updated_at", displayName: "更新日時" },
      { name: "id", displayName: "" }, // 空 = 削除の意思として保持する
    ]);
  });

  it("タグ・色の列も読む（タグは空白・カンマ区切り）", () => {
    const rows = parseTsvRows("email\tメールアドレス\tpii, 監査\tamber");
    expect(rows).toEqual([
      { name: "email", displayName: "メールアドレス", tags: ["pii", "監査"], color: "amber" },
    ]);
  });

  it("列が無かった項目は据え置き、列があって空なら消える", () => {
    const before = { displayName: "旧", tags: ["pii"], color: "red" };
    const [twoCols] = parseTsvRows("email\tメールアドレス");
    expect(applyPastedRow(before, twoCols!)).toEqual({
      displayName: "メールアドレス",
      tags: ["pii"],
      color: "red",
    });
    const [fourCols] = parseTsvRows("email\tメールアドレス\t\t");
    expect(applyPastedRow(before, fourCols!)).toEqual({
      displayName: "メールアドレス",
      tags: [],
      color: "",
    });
  });
});
