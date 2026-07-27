ERD.table({
  id: "public.user_sessions",
  name: "user_sessions",
  schema: "public",
  comment: "ユーザーログインセッション",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "user_id", type: "int4", logicalType: "int", nullable: false },
    { name: "session_token", type: "varchar(255)", logicalType: "string", nullable: false },
    { name: "created_at", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
    { name: "expires_at", type: "timestamptz", logicalType: "datetime", nullable: true },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "user_sessions_session_token_key", columns: ["session_token"] },
  ],
  foreignKeys: [
    { name: "user_sessions_user_id_fkey", columns: ["user_id"], ref: { table: "public.users", columns: ["id"] } },
  ],
  meta: {
    displayName: "ユーザーログインセッション",
    tags: ["auth"],
    color: "blue",
  },
});
