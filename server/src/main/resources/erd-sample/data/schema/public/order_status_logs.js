ERD.table({
  id: "public.order_status_logs",
  name: "order_status_logs",
  schema: "public",
  comment: "注文ステータス履歴",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "order_id", type: "int4", logicalType: "int", nullable: false },
    { name: "status", type: "varchar(50)", logicalType: "string", nullable: false },
    { name: "updated_at", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "order_status_logs_order_id_fkey", columns: ["order_id"], ref: { table: "public.orders", columns: ["id"] } },
  ],
  meta: {
    displayName: "注文ステータス履歴",
    tags: ["order"],
    color: "amber",
  },
});
