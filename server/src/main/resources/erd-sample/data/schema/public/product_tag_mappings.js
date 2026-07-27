ERD.table({
  id: "public.product_tag_mappings",
  name: "product_tag_mappings",
  schema: "public",
  comment: "商品とタグのマッピング",
  columns: [
    { name: "product_id", type: "int4", logicalType: "int", nullable: false },
    { name: "tag_id", type: "int4", logicalType: "int", nullable: false },
  ],
  primaryKey: ["product_id", "tag_id"],
  foreignKeys: [
    { name: "product_tag_mappings_product_id_fkey", columns: ["product_id"], ref: { table: "public.products", columns: ["id"] } },
    { name: "product_tag_mappings_tag_id_fkey", columns: ["tag_id"], ref: { table: "public.product_tags", columns: ["id"] } },
  ],
  meta: {
    displayName: "商品とタグのマッピング",
    tags: ["catalog"],
    color: "green",
  },
});
