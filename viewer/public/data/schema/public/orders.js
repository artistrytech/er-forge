ERD.table({
  id: "public.orders",
  name: "orders",
  schema: "public",
  comment: "注文",
  columns: [
    { name: "id", type: "bigserial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "user_id", type: "int8", logicalType: "int", nullable: false },
    { name: "code", type: "varchar(20)", logicalType: "string", nullable: false, comment: "注文番号" },
    { name: "status", type: "varchar(20)", logicalType: "string", nullable: false, "default": "'draft'", comment: "注文状態" },
    { name: "total_amount", type: "numeric(12,2)", logicalType: "decimal", nullable: false, "default": "0" },
    { name: "created_at", type: "timestamptz", logicalType: "datetime", nullable: false, "default": "now()" },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "orders_code_key", columns: ["code"] },
  ],
  indexes: [
    { name: "idx_orders_user_id", columns: ["user_id"] },
  ],
  foreignKeys: [
    { name: "orders_user_id_fkey", columns: ["user_id"], ref: { table: "public.users", columns: ["id"] }, onDelete: "cascade" },
  ],
  meta: {
    displayName: "注文",
    tags: ["billing", "core"],
    columns: {
      status: { displayName: "注文状態", notes: "draft / confirmed / shipped / cancelled" },
      total_amount: { displayName: "合計金額" },
    },
  },
});
