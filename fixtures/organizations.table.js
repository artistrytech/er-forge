ERD.table({
  id: "public.organizations",
  name: "organizations",
  schema: "public",
  comment: "組織",
  columns: [
    { name: "id", type: "bigserial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "name", type: "varchar(120)", logicalType: "string", nullable: false },
  ],
  primaryKey: ["id"],
  meta: {
    displayName: "組織",
  },
});
