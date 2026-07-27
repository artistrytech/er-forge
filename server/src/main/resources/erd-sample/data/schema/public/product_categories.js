ERD.table({
  id: "public.product_categories",
  name: "product_categories",
  schema: "public",
  comment: "商品カテゴリ",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "category_name", type: "varchar(100)", logicalType: "string", nullable: false },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "product_categories_category_name_key", columns: ["category_name"] },
  ],
  meta: {
    displayName: "商品カテゴリ",
    tags: ["catalog", "master"],
    color: "green",
  },
});
