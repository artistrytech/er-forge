ERD.table({
  id: "public.product_reviews",
  name: "product_reviews",
  schema: "public",
  comment: "商品レビュー",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "product_id", type: "int4", logicalType: "int", nullable: false },
    { name: "user_id", type: "int4", logicalType: "int", nullable: false },
    { name: "rating", type: "int4", logicalType: "int", nullable: false },
    { name: "comment", type: "text", logicalType: "string", nullable: true },
    { name: "created_at", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "product_reviews_product_id_fkey", columns: ["product_id"], ref: { table: "public.products", columns: ["id"] } },
    { name: "product_reviews_user_id_fkey", columns: ["user_id"], ref: { table: "public.users", columns: ["id"] } },
  ],
  meta: {
    displayName: "商品レビュー",
    tags: ["catalog"],
  },
});
