/**
 * 詳細ダイアログからのカーディナリティ・カラム対応の編集（R-05）。
 * 書き換えるのは対象の1か所だけで、多重度の補足・ほかの制約は巻き添えにしない。
 * 他で変更されていたときは中止（null）する。
 */
import { describe, expect, it } from "vitest";
import { writeCardinality, writeFkColumns, writeUniqueColumns } from "../src/model/constraintEdit";
import { EMPTY_CARDINALITY, buildDraft, draftToMeta } from "../src/model/metaDraft";
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
  foreignKeys: [
    {
      name: "order_items_order_id_fkey",
      columns: ["order_id"],
      ref: { table: "public.orders", columns: ["id"] },
    },
  ],
  meta: {
    logicalUniques: [
      { name: "luk_order_items_order_id_product_id", columns: ["order_id", "product_id"] },
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
      "fk:order_items_order_id_fkey": { child: "1..N", notes: "注文には必ず1明細以上" },
      "lfk:lfk_order_items_inventories": { notes: "在庫は後追いで作られる" },
    },
  } as Table["meta"],
};

/** 書き換え後の meta（保存ペイロード） */
function metaOf(next: ReturnType<typeof writeCardinality>): Record<string, unknown> {
  expect(next).not.toBeNull();
  return draftToMeta(next!, items) as Record<string, unknown>;
}

describe("writeCardinality", () => {
  it("物理FK の多重度を書き、補足（notes）はそのまま残す", () => {
    const meta = metaOf(
      writeCardinality(buildDraft(items), { kind: "fk", name: "order_items_order_id_fkey" }, {
        ...EMPTY_CARDINALITY,
        parent: "1..1",
        child: "0..N",
      }),
    );
    expect(meta["relations"]).toEqual({
      "fk:order_items_order_id_fkey": {
        parent: "1..1",
        child: "0..N",
        notes: "注文には必ず1明細以上",
      },
      "lfk:lfk_order_items_inventories": { notes: "在庫は後追いで作られる" },
    });
  });

  it("論理外部制約の多重度は制約名で引いて書く", () => {
    const meta = metaOf(
      writeCardinality(buildDraft(items), { kind: "lfk", name: "lfk_order_items_inventories" }, {
        ...EMPTY_CARDINALITY,
        child: "0..1",
      }),
    );
    expect((meta["relations"] as Record<string, unknown>)["lfk:lfk_order_items_inventories"]).toEqual({
      child: "0..1",
      notes: "在庫は後追いで作られる",
    });
  });

  it("上書きを外すとキーごと落ちる（補足だけが残る）", () => {
    const meta = metaOf(
      writeCardinality(
        buildDraft(items),
        { kind: "fk", name: "order_items_order_id_fkey" },
        { ...EMPTY_CARDINALITY },
      ),
    );
    expect((meta["relations"] as Record<string, unknown>)["fk:order_items_order_id_fkey"]).toEqual({
      notes: "注文には必ず1明細以上",
    });
  });

  it("対象が見当たらなければ中止する", () => {
    expect(
      writeCardinality(buildDraft(items), { kind: "fk", name: "消えたFK" }, { ...EMPTY_CARDINALITY }),
    ).toBeNull();
    expect(
      writeCardinality(buildDraft(items), { kind: "lfk", name: "消えた制約" }, { ...EMPTY_CARDINALITY }),
    ).toBeNull();
  });
});

describe("writeFkColumns", () => {
  it("カラム対応だけを差し替え、参照先テーブル・注記は動かさない", () => {
    const next = writeFkColumns(
      buildDraft(items),
      "lfk_order_items_inventories",
      ["order_id", "product_id"],
      ["order_id", "product_id"],
    );
    const meta = metaOf(next);
    expect(meta["logicalForeignKeys"]).toEqual([
      {
        name: "lfk_order_items_inventories",
        columns: ["order_id", "product_id"],
        ref: { table: "public.inventories", columns: ["order_id", "product_id"] },
        notes: "在庫への論理参照",
      },
    ]);
  });

  it("対象が見当たらなければ中止する", () => {
    expect(writeFkColumns(buildDraft(items), "消えた制約", ["id"], ["id"])).toBeNull();
  });
});

describe("writeUniqueColumns", () => {
  it("対象カラムを差し替える", () => {
    const meta = metaOf(writeUniqueColumns(buildDraft(items), { at: 0 }, ["product_id"]));
    expect(meta["logicalUniques"]).toEqual([
      { name: "luk_order_items_order_id_product_id", columns: ["product_id"] },
    ]);
  });

  it("名前が食い違う / 位置が範囲外なら中止する", () => {
    expect(
      writeUniqueColumns(buildDraft(items), { at: 0, name: "別の制約" }, ["product_id"]),
    ).toBeNull();
    expect(writeUniqueColumns(buildDraft(items), { at: 3 }, ["product_id"])).toBeNull();
  });
});
