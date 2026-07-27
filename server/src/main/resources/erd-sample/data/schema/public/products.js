ERD.table({
  id: "public.products",
  name: "products",
  schema: "public",
  comment: "商品",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "category_id", type: "int4", logicalType: "int", nullable: true },
    { name: "product_name", type: "varchar(255)", logicalType: "string", nullable: false },
    { name: "description", type: "text", logicalType: "string", nullable: true },
    { name: "price", type: "numeric(10,2)", logicalType: "decimal", nullable: false },
    { name: "created_at", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "products_category_id_fkey", columns: ["category_id"], ref: { table: "public.product_categories", columns: ["id"] } },
  ],
  meta: {
    displayName: "商品",
    tags: ["catalog"],
    color: "green",
  },
});
