ERD.table({
  id: "public.order_items",
  name: "order_items",
  schema: "public",
  comment: "注文明細",
  columns: [
    { name: "id", type: "bigserial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "order_id", type: "int8", logicalType: "int", nullable: false },
    { name: "product_id", type: "int8", logicalType: "int", nullable: false },
    { name: "quantity", type: "int4", logicalType: "int", nullable: false, "default": "1", comment: "数量" },
    { name: "unit_price", type: "numeric(12,2)", logicalType: "decimal", nullable: false, comment: "販売時単価" },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "order_items_order_product_key", columns: ["order_id", "product_id"] },
  ],
  foreignKeys: [
    { name: "order_items_order_id_fkey", columns: ["order_id"], ref: { table: "public.orders", columns: ["id"] }, onDelete: "cascade" },
    { name: "order_items_product_id_fkey", columns: ["product_id"], ref: { table: "public.products", columns: ["id"] } },
  ],
  meta: {
    displayName: "注文明細",
    tags: ["billing"],
    relations: {
      "fk:order_items_order_id_fkey": { child: "1..N", notes: "注文には必ず1明細以上が存在する" },
    },
  },
});
