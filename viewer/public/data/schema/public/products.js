ERD.table({
  id: "public.products",
  name: "products",
  schema: "public",
  comment: "商品マスタ",
  columns: [
    { name: "id", type: "bigserial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "sku", type: "varchar(40)", logicalType: "string", nullable: false, comment: "SKU コード" },
    { name: "name", type: "varchar(200)", logicalType: "string", nullable: false, comment: "商品名" },
    { name: "price", type: "numeric(12,2)", logicalType: "decimal", nullable: false, comment: "単価" },
    { name: "created_at", type: "timestamptz", logicalType: "datetime", nullable: false, "default": "now()" },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "products_sku_key", columns: ["sku"] },
  ],
  meta: {
    displayName: "商品",
    tags: ["billing"],
  },
});
