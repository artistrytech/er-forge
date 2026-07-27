ERD.table({
  id: "public.shipments",
  name: "shipments",
  schema: "public",
  comment: "出荷情報",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "order_id", type: "int4", logicalType: "int", nullable: false },
    { name: "shipment_date", type: "timestamptz", logicalType: "datetime", nullable: true },
    { name: "carrier", type: "varchar(100)", logicalType: "string", nullable: true },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "shipments_order_id_fkey", columns: ["order_id"], ref: { table: "public.orders", columns: ["id"] } },
  ],
  meta: {
    displayName: "出荷情報",
    tags: ["order"],
    color: "amber",
    relations: {
      "fk:shipments_order_id_fkey": { child: "0..1", notes: "注文につき出荷は最大1回（分割出荷はしない）" },
    },
  },
});
