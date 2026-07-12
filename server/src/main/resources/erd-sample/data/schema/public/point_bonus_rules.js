ERD.table({
  id: "public.point_bonus_rules",
  name: "point_bonus_rules",
  schema: "public",
  comment: "ボーナスポイントルール",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "campaign_id", type: "int4", logicalType: "int", nullable: false },
    { name: "bonus_rate", type: "numeric(5,2)", logicalType: "decimal", nullable: false },
  ],
  primaryKey: ["id"],
  foreignKeys: [
    { name: "point_bonus_rules_campaign_id_fkey", columns: ["campaign_id"], ref: { table: "public.point_campaigns", columns: ["id"] } },
  ],
  meta: {
    displayName: "ボーナスポイントルール",
    tags: ["point"],
    columns: {
      bonus_rate: { notes: "% 表記（例: 10.00）" },
    },
  },
});
