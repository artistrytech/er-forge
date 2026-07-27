ERD.table({
  id: "public.roles",
  name: "roles",
  schema: "public",
  comment: "ロール（権限）",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "role_name", type: "varchar(50)", logicalType: "string", nullable: false },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "roles_role_name_key", columns: ["role_name"] },
  ],
  meta: {
    displayName: "ロール（権限）",
    tags: ["auth", "master"],
    color: "blue",
  },
});
