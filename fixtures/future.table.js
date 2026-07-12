ERD.table({
  id: "public.future",
  name: "future",
  schema: "public",
  columns: [
    { name: "id", type: "int4", logicalType: "int", nullable: false, sensitivity: "high" },
  ],
  primaryKey: ["id"],
  meta: {
    displayName: "未来",
    reviewedBy: "本田",
  },
  futureFeature: {
    enabled: true,
    thresholds: [1, 2, 3],
  },
  futureFlag: true,
});
