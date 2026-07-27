ERD.index({
  tables: [
    { id: "public.audit_logs", name: "audit_logs", schema: "public", displayName: "監査ログ", columns: 4, pk: true },
    { id: "public.order_items", name: "order_items", schema: "public", displayName: "注文明細", columns: 5, pk: true, tags: ["billing"], diagrams: ["billing"] },
    { id: "public.orders", name: "orders", schema: "public", displayName: "注文", columns: 6, pk: true, tags: ["billing", "core"], diagrams: ["billing", "core"] },
    { id: "public.organizations", name: "organizations", schema: "public", displayName: "組織", columns: 3, pk: true, tags: ["core"], diagrams: ["core"] },
    { id: "public.products", name: "products", schema: "public", displayName: "商品", columns: 5, pk: true, tags: ["billing"], diagrams: ["billing"] },
    { id: "public.users", name: "users", schema: "public", displayName: "ユーザー", columns: 5, pk: true, tags: ["auth", "core"], color: "blue", diagrams: ["core"] },
  ],
  relations: [
    { id: "public.order_items#fk:order_items_order_id_fkey", kind: "physical", from: "public.order_items", to: "public.orders", columns: [["order_id", "id"]], cardinality: { parent: "1..1", child: "1..N" }, explicit: ["child"] },
    { id: "public.order_items#fk:order_items_product_id_fkey", kind: "physical", from: "public.order_items", to: "public.products", columns: [["product_id", "id"]], cardinality: { parent: "1..1", child: "0..N" } },
    { id: "public.orders#fk:orders_user_id_fkey", kind: "physical", from: "public.orders", to: "public.users", columns: [["user_id", "id"]], cardinality: { parent: "1..1", child: "0..N" } },
    { id: "public.organizations#fk:organizations_parent_org_id_fkey", kind: "physical", from: "public.organizations", to: "public.organizations", columns: [["parent_org_id", "id"]], cardinality: { parent: "0..1", child: "0..N" } },
    { id: "public.users#fk:users_org_id_fkey", kind: "physical", from: "public.users", to: "public.organizations", columns: [["org_id", "id"]], cardinality: { parent: "0..1", child: "1..N" }, explicit: ["child"] },
    { id: "public.users#lfk:lfk_users_last_order", kind: "logical", from: "public.users", to: "public.orders", columns: [["last_order_id", "id"]], cardinality: { parent: "0..1", child: "0..N" } },
  ],
  tagsUsed: ["auth", "billing", "core", "pii", "廃止"],
});
