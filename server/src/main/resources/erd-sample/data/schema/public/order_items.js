ERD.table({
  id: "public.order_items",
  name: "order_items",
  schema: "public",
  comment: "注文アイテム",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "order_id", type: "int4", logicalType: "int", nullable: false },
    { name: "product_id", type: "int4", logicalType: "int", nullable: false },
    { name: "quantity", type: "int4", logicalType: "int", nullable: false },
    { name: "price", type: "numeric(10,2)", logicalType: "decimal", nullable: false },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "order_items_order_id_fkey", columns: ["order_id"], ref: { table: "public.orders", columns: ["id"] } },
    { name: "order_items_product_id_fkey", columns: ["product_id"], ref: { table: "public.products", columns: ["id"] } },
  ],
  meta: {
    displayName: "注文アイテム",
    tags: ["order"],
    logicalForeignKeys: [
      { name: "lfk_order_items_inventories", columns: ["product_id"], ref: { table: "public.inventories", columns: ["product_id"] }, notes: "在庫への論理参照（FK なし。在庫行が後から作られることがある）" },
    ],
    relations: {
      "fk:order_items_order_id_fkey": { child: "1..N", notes: "注文には必ず1明細以上が存在する" },
    },
  },
});
