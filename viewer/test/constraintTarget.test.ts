/**
 * 詳細ダイアログ / ER図からの論理制約の削除（R-05）。
 * 対象の指し方（名前 / 位置）と、他で変更されていたときの中止（null）を確かめる。
 */
import { describe, expect, it } from "vitest";
import { removeConstraint } from "../src/model/constraintTarget";
import { buildDraft, draftToMeta } from "../src/model/metaDraft";
import type { Table } from "../src/model/types";

const items: Table = {
  id: "public.order_items",
  name: "order_items",
  schema: "public",
  columns: [
    { name: "id", type: "int4", logicalType: "int", nullable: false },
    { name: "order_id", type: "int4", logicalType: "int", nullable: false },
    { name: "product_id", type: "int4", logicalType: "int", nullable: false },
  ],
  primaryKey: ["id"],
  meta: {
    logicalUniques: [
      { name: "luk_order_items_order_id_product_id", columns: ["order_id", "product_id"] },
      { name: "luk_order_items_product_id", columns: ["product_id"], notes: "残す方" },
    ],
    logicalForeignKeys: [
      {
        name: "lfk_order_items_inventories",
        columns: ["product_id"],
        ref: { table: "public.inventories", columns: ["product_id"] },
        notes: "在庫への論理参照",
      },
    ],
    relations: {
      "lfk:lfk_order_items_inventories": { child: "0..N", notes: "在庫は後追いで作られる" },
      "fk:order_items_order_id_fkey": { child: "1..N" },
    },
  } as Table["meta"],
};

/** 削除後の meta（保存ペイロード） */
function metaAfter(target: Parameters<typeof removeConstraint>[1]): Record<string, unknown> {
  const next = removeConstraint(buildDraft(items), target);
  expect(next).not.toBeNull();
  return draftToMeta(next!, items) as Record<string, unknown>;
}

describe("removeConstraint", () => {
  it("論理外部制約を名前で消し、そのカーディナリティも一緒に落とす", () => {
    const meta = metaAfter({
      kind: "logicalFk",
      tableId: items.id,
      name: "lfk_order_items_inventories",
    });
    expect(meta["logicalForeignKeys"]).toBeUndefined();
    // 物理FK の設定は残る（消すのは対象の制約の分だけ）
    expect(meta["relations"]).toEqual({ "fk:order_items_order_id_fkey": { child: "1..N" } });
  });

  it("論理一意制約は位置で消し、残りはそのまま", () => {
    const meta = metaAfter({ kind: "logicalUnique", tableId: items.id, at: 0 });
    expect(meta["logicalUniques"]).toEqual([
      { name: "luk_order_items_product_id", columns: ["product_id"], notes: "残す方" },
    ]);
  });

  it("名前が食い違えば中止する（他で並びが変わった）", () => {
    expect(
      removeConstraint(buildDraft(items), {
        kind: "logicalUnique",
        tableId: items.id,
        at: 0,
        name: "luk_order_items_product_id",
      }),
    ).toBeNull();
    expect(
      removeConstraint(buildDraft(items), {
        kind: "logicalFk",
        tableId: items.id,
        name: "lfk_消えた制約",
      }),
    ).toBeNull();
  });

  it("位置が範囲外なら中止する（他で消された）", () => {
    expect(
      removeConstraint(buildDraft(items), { kind: "logicalUnique", tableId: items.id, at: 5 }),
    ).toBeNull();
  });
});
