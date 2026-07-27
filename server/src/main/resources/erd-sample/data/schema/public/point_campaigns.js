ERD.table({
  id: "public.point_campaigns",
  name: "point_campaigns",
  schema: "public",
  comment: "ポイントキャンペーン",
  columns: [
    { name: "id", type: "serial", logicalType: "int", nullable: false, autoIncrement: true },
    { name: "campaign_name", type: "varchar(100)", logicalType: "string", nullable: false },
    { name: "start_date", type: "date", logicalType: "date", nullable: true },
    { name: "end_date", type: "date", logicalType: "date", nullable: true },
  ],
  primaryKey: ["id"],
  meta: {
    displayName: "ポイントキャンペーン",
    tags: ["point", "master"],
    color: "red",
  },
});
