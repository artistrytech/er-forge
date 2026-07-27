ERD.table({
  id: "public.inventories",
  name: "inventories",
  schema: "public",
  comment: "在庫管理",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "product_id", type: "int4", logicalType: "int", nullable: false },
    { name: "quantity", type: "int4", logicalType: "int", nullable: false, "default": "0" },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "inventories_product_id_fkey", columns: ["product_id"], ref: { table: "public.products", columns: ["id"] } },
  ],
  meta: {
    displayName: "在庫管理",
    tags: ["catalog"],
    color: "green",
    logicalUniques: [
      { name: "luk_inventories_product", columns: ["product_id"], notes: "商品ごとに在庫レコードは1件" },
    ],
  },
});
