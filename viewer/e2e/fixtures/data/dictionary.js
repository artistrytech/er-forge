ERD.dictionary({
  columns: {
    created_at: { displayName: "作成日時", tags: ["監査"], color: "muted" },
    email: { displayName: "メールアドレス", tags: ["pii"], color: "amber" },
    id: { displayName: "ID" },
    org_id: { displayName: "組織ID" },
    updated_at: { displayName: "更新日時", tags: ["監査"], color: "muted" },
  },
});
