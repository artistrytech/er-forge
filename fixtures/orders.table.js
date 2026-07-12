ERD.table({
  id: "public.orders",
  name: "orders",
  schema: "public",
  comment: "注文",
  columns: [
    { name: "id", type: "bigserial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "user_id", type: "int8", logicalType: "int", nullable: false },
    { name: "code", type: "varchar(32)", logicalType: "string", nullable: false },
    { name: "total", type: "numeric(12,2)", logicalType: "decimal", nullable: false, "default": "0" },
    { name: "created_at", type: "timestamptz", logicalType: "datetime", nullable: false, "default": "now()" },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "orders_code_key", columns: ["code"] },
  ],
  foreignKeys: [
    { name: "orders_user_id_fkey", columns: ["user_id"], ref: { table: "public.users", columns: ["id"] } },
  ],
  meta: {
    displayName: "注文",
    tags: ["core"],
    logicalForeignKeys: [
      { name: "lfk_orders_legacy", columns: ["code"], ref: { table: "public.legacy_orders", columns: ["code"] }, notes: "旧システムの注文（アーカイブ済み）" },
    ],
  },
});
