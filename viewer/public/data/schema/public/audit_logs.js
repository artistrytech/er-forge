ERD.table({
  id: "public.audit_logs",
  name: "audit_logs",
  schema: "public",
  comment: "監査ログ。全操作を追記のみで記録する",
  columns: [
    { name: "id", type: "bigserial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "event", type: "varchar(60)", logicalType: "string", nullable: false, comment: "イベント種別" },
    { name: "payload", type: "jsonb", logicalType: "json", nullable: true },
    { name: "created_at", type: "timestamptz", logicalType: "datetime", nullable: false, "default": "now()" },
  ],
  primaryKey: ["id"],
  indexes: [
    { name: "idx_audit_logs_created_at", columns: ["created_at"] },
  ],
  meta: {
    displayName: "監査ログ",
    notes: "FK を持たない追記専用テーブル。ER図には未配置",
  },
});
