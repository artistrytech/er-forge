ERD.table({
  id: "public.points",
  name: "points",
  schema: "public",
  comment: "ポイント残高",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "user_id", type: "int4", logicalType: "int", nullable: false },
    { name: "balance", type: "int4", logicalType: "int", nullable: false, "default": "0" },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "points_user_id_fkey", columns: ["user_id"], ref: { table: "public.users", columns: ["id"] } },
  ],
  meta: {
    displayName: "ポイント残高",
    tags: ["point"],
    color: "red",
    logicalUniques: [
      { name: "luk_points_user", columns: ["user_id"], notes: "ユーザーごとに残高レコードは1件" },
    ],
  },
});
