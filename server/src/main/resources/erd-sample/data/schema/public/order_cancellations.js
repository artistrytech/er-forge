ERD.table({
  id: "public.order_cancellations",
  name: "order_cancellations",
  schema: "public",
  comment: "注文キャンセル情報",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "order_id", type: "int4", logicalType: "int", nullable: false },
    { name: "reason", type: "text", logicalType: "string", nullable: true },
    { name: "cancelled_at", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "order_cancellations_order_id_fkey", columns: ["order_id"], ref: { table: "public.orders", columns: ["id"] } },
  ],
  meta: {
    displayName: "注文キャンセル情報",
    tags: ["order"],
  },
});
