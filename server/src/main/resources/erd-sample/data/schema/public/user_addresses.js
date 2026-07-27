ERD.table({
  id: "public.user_addresses",
  name: "user_addresses",
  schema: "public",
  comment: "ユーザー住所",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "user_id", type: "int4", logicalType: "int", nullable: false },
    { name: "address_line1", type: "varchar(255)", logicalType: "string", nullable: false },
    { name: "address_line2", type: "varchar(255)", logicalType: "string", nullable: true },
    { name: "city", type: "varchar(100)", logicalType: "string", nullable: true },
    { name: "postal_code", type: "varchar(20)", logicalType: "string", nullable: true },
    { name: "country", type: "varchar(100)", logicalType: "string", nullable: true },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "user_addresses_user_id_fkey", columns: ["user_id"], ref: { table: "public.users", columns: ["id"] } },
  ],
  meta: {
    displayName: "ユーザー住所",
    tags: ["auth"],
    color: "blue",
  },
});
