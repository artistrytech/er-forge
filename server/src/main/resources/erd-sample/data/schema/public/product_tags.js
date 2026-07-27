ERD.table({
  id: "public.product_tags",
  name: "product_tags",
  schema: "public",
  comment: "商品タグ",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "tag_name", type: "varchar(50)", logicalType: "string", nullable: false },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "product_tags_tag_name_key", columns: ["tag_name"] },
  ],
  meta: {
    displayName: "商品タグ",
    tags: ["catalog", "master"],
    color: "green",
  },
});
