ERD.table({
  id: "public.product_images",
  name: "product_images",
  schema: "public",
  comment: "商品画像",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "product_id", type: "int4", logicalType: "int", nullable: false },
    { name: "image_url", type: "varchar(500)", logicalType: "string", nullable: false },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "product_images_product_id_fkey", columns: ["product_id"], ref: { table: "public.products", columns: ["id"] } },
  ],
  meta: {
    displayName: "商品画像",
    tags: ["catalog"],
    color: "green",
  },
});
