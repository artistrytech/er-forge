ERD.table({
  id: "public.organizations",
  name: "organizations",
  schema: "public",
  comment: "組織マスタ",
  columns: [
    { name: "id", type: "bigserial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "name", type: "varchar(120)", logicalType: "string", nullable: false, comment: "組織名" },
    { name: "parent_org_id", type: "int8", logicalType: "int", nullable: true, comment: "親組織ID" },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "organizations_parent_org_id_fkey", columns: ["parent_org_id"], ref: { table: "public.organizations", columns: ["id"] }, onDelete: "set null" },
  ],
  meta: {
    displayName: "組織",
    tags: ["core"],
    columns: {
      parent_org_id: { displayName: "親組織ID", notes: "NULL はルート組織" },
    },
  },
});
