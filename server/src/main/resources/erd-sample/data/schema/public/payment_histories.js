ERD.table({
  id: "public.payment_histories",
  name: "payment_histories",
  schema: "public",
  comment: "支払履歴詳細",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "payment_id", type: "int4", logicalType: "int", nullable: false },
    { name: "status", type: "varchar(50)", logicalType: "string", nullable: false },
    { name: "processed_at", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "payment_histories_payment_id_fkey", columns: ["payment_id"], ref: { table: "public.payments", columns: ["id"] } },
  ],
  meta: {
    displayName: "支払履歴詳細",
    tags: ["billing"],
  },
});
