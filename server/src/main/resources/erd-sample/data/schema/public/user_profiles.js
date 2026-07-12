ERD.table({
  id: "public.user_profiles",
  name: "user_profiles",
  schema: "public",
  comment: "ユーザープロファイル",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "user_id", type: "int4", logicalType: "int", nullable: false },
    { name: "full_name", type: "varchar(255)", logicalType: "string", nullable: true },
    { name: "phone_number", type: "varchar(20)", logicalType: "string", nullable: true },
    { name: "birth_date", type: "date", logicalType: "date", nullable: true },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "user_profiles_user_id_fkey", columns: ["user_id"], ref: { table: "public.users", columns: ["id"] } },
  ],
  meta: {
    displayName: "ユーザープロファイル",
    tags: ["auth"],
    logicalUniques: [
      { name: "luk_user_profiles_user", columns: ["user_id"], notes: "1ユーザーにつきプロファイルは1件（アプリ側で担保）" },
    ],
  },
});
