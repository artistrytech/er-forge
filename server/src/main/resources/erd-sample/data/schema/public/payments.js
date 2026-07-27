ERD.table({
  id: "public.payments",
  name: "payments",
  schema: "public",
  comment: "支払情報",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "order_id", type: "int4", logicalType: "int", nullable: false },
    { name: "payment_method_id", type: "int4", logicalType: "int", nullable: true },
    { name: "payment_date", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
    { name: "amount", type: "numeric(10,2)", logicalType: "decimal", nullable: false },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "payments_order_id_fkey", columns: ["order_id"], ref: { table: "public.orders", columns: ["id"] } },
    { name: "payments_payment_method_id_fkey", columns: ["payment_method_id"], ref: { table: "public.payment_methods", columns: ["id"] } },
  ],
  meta: {
    displayName: "支払情報",
    tags: ["billing"],
    color: "purple",
  },
});
