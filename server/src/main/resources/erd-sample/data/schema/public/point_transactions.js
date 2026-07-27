ERD.table({
  id: "public.point_transactions",
  name: "point_transactions",
  schema: "public",
  comment: "ポイント履歴",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "user_id", type: "int4", logicalType: "int", nullable: false },
    { name: "points", type: "int4", logicalType: "int", nullable: false },
    { name: "transaction_date", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
    { name: "description", type: "varchar(255)", logicalType: "string", nullable: true },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "point_transactions_user_id_fkey", columns: ["user_id"], ref: { table: "public.users", columns: ["id"] } },
  ],
  meta: {
    displayName: "ポイント履歴",
    tags: ["point"],
    color: "red",
    notes: "残高（points.balance）はこの履歴の集計と一致する運用",
    logicalForeignKeys: [
      { name: "lfk_point_transactions_points", columns: ["user_id"], ref: { table: "public.points", columns: ["user_id"] }, notes: "残高テーブルへの論理参照（履歴書き込みの性能上 FK は張っていない）" },
    ],
  },
});
