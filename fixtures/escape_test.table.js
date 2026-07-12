ERD.table({
  id: "public.escape_test",
  name: "escape_test",
  schema: "public",
  columns: [
    { name: "id", type: "int4", logicalType: "int", nullable: false },
    { name: "default", type: "varchar(10)", logicalType: "string", nullable: true },
    { name: "class", type: "varchar(10)", logicalType: "string", nullable: true },
  ],
  primaryKey: ["id"],
  meta: {
    notes: "1行目\n2行目\tタブ \"引用\" \\バックスラッシュ\u2028LINE SEPARATOR \u2029PARAGRAPH SEPARATOR ",
    columns: {
      "default": { displayName: "既定値", notes: "1行目\n2行目\tタブ \"引用\" \\バックスラッシュ\u2028LINE SEPARATOR \u2029PARAGRAPH SEPARATOR " },
      "class": { displayName: "区分" },
    },
  },
});
