ERD.table({
  id: "public.payment_methods",
  name: "payment_methods",
  schema: "public",
  comment: "支払方法マスタ",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "method_name", type: "varchar(50)", logicalType: "string", nullable: false },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "payment_methods_method_name_key", columns: ["method_name"] },
  ],
  meta: {
    displayName: "支払方法マスタ",
    tags: ["billing", "master"],
  },
});
