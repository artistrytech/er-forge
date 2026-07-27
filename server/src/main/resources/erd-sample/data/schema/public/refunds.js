ERD.table({
  id: "public.refunds",
  name: "refunds",
  schema: "public",
  comment: "返金情報",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "payment_id", type: "int4", logicalType: "int", nullable: false },
    { name: "refund_date", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
    { name: "amount", type: "numeric(10,2)", logicalType: "decimal", nullable: false },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "refunds_payment_id_fkey", columns: ["payment_id"], ref: { table: "public.payments", columns: ["id"] } },
  ],
  meta: {
    displayName: "返金情報",
    tags: ["billing"],
    color: "purple",
  },
});
