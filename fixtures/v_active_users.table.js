ERD.table({
  id: "public.v_active_users",
  name: "v_active_users",
  schema: "public",
  kind: "VIEW",
  comment: "有効なユーザーの抽出",
  columns: [
    { name: "id", type: "int8", logicalType: "int", nullable: true },
    { name: "email", type: "varchar(255)", logicalType: "string", nullable: true },
  ],
  meta: {
    displayName: "有効ユーザー",
    tags: ["core"],
    logicalForeignKeys: [
      { name: "lfk_v_active_users_users", columns: ["id"], ref: { table: "public.users", columns: ["id"] }, notes: "ビューの抽出元" },
    ],
  },
});
