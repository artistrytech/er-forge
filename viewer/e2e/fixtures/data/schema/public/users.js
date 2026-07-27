ERD.table({
  id: "public.users",
  name: "users",
  schema: "public",
  comment: "ユーザーマスタ",
  columns: [
    { name: "id", type: "bigserial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "email", type: "varchar(255)", logicalType: "string", nullable: false },
    { name: "org_id", type: "int8", logicalType: "int", nullable: true },
    { name: "last_order_id", type: "int8", logicalType: "int", nullable: true },
    { name: "created_at", type: "timestamptz", logicalType: "datetime", nullable: false, "default": "now()", comment: "作成日時" },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "users_email_key", columns: ["email"] },
  ],
  indexes: [
    { name: "idx_users_created_at", columns: ["created_at"] },
  ],
  foreignKeys: [
    { name: "users_org_id_fkey", columns: ["org_id"], ref: { table: "public.organizations", columns: ["id"] }, onDelete: "set null" },
  ],
  meta: {
    displayName: "ユーザー",
    tags: ["auth", "core"],
    color: "blue",
    notes: "論理削除は deleted_at 運用",
    columns: {
      org_id: { displayName: "所属組織ID", tags: ["pii"], notes: "NULL は個人アカウント" },
      last_order_id: { tags: ["廃止"], color: "muted" },
    },
    logicalUniques: [
      { name: "luk_users_org_email", columns: ["org_id", "email"], notes: "組織内でメールは重複しない（アプリ側で担保）" },
    ],
    logicalForeignKeys: [
      { name: "lfk_users_last_order", columns: ["last_order_id"], ref: { table: "public.orders", columns: ["id"] }, notes: "性能上 FK を張っていない" },
    ],
    relations: {
      "fk:users_org_id_fkey": { child: "1..N", notes: "組織には必ず1人以上の利用者がいる" },
    },
  },
});
