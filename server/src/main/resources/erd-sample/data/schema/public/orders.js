ERD.table({
  id: "public.orders",
  name: "orders",
  schema: "public",
  comment: "注文",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "user_id", type: "int4", logicalType: "int", nullable: false },
    { name: "order_date", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
    { name: "status", type: "varchar(50)", logicalType: "string", nullable: false },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "orders_user_id_fkey", columns: ["user_id"], ref: { table: "public.users", columns: ["id"] } },
  ],
  meta: {
    displayName: "注文",
    tags: ["order"],
    color: "amber",
    columns: {
      status: { displayName: "注文ステータス", tags: ["enum"], notes: "PENDING / PAID / SHIPPED / CANCELLED" },
    },
  },
});
