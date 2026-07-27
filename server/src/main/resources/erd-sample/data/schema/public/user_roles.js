ERD.table({
  id: "public.user_roles",
  name: "user_roles",
  schema: "public",
  comment: "ユーザーとロールの紐付け",
  columns: [
    { name: "user_id", type: "int4", logicalType: "int", nullable: false },
    { name: "role_id", type: "int4", logicalType: "int", nullable: false },
  ],
  primaryKey: ["user_id", "role_id"],
  foreignKeys: [
    { name: "user_roles_role_id_fkey", columns: ["role_id"], ref: { table: "public.roles", columns: ["id"] } },
    { name: "user_roles_user_id_fkey", columns: ["user_id"], ref: { table: "public.users", columns: ["id"] } },
  ],
  meta: {
    displayName: "ユーザーとロールの紐付け",
    tags: ["auth"],
    color: "blue",
  },
});
