ERD.table({
  id: "public.users",
  name: "users",
  schema: "public",
  comment: "ユーザー情報",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "email", type: "varchar(255)", logicalType: "string", nullable: false },
    { name: "password", type: "varchar(255)", logicalType: "string", nullable: false },
    { name: "created_at", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
    { name: "updated_at", type: "timestamptz", logicalType: "datetime", nullable: true, "default": "now()" },
  ],
  primaryKey: ["id"],
  uniques: [
    { name: "users_email_key", columns: ["email"] },
  ],
  meta: {
    displayName: "ユーザー情報",
    tags: ["auth"],
    color: "blue",
  },
});
