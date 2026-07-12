ERD.index({
  tables: [
    { id: "public.orders", name: "orders", schema: "public", displayName: "注文", columns: 5, pk: true, tags: ["core"], diagrams: ["core"] },
    { id: "public.organizations", name: "organizations", schema: "public", displayName: "組織", columns: 2, pk: true, diagrams: ["core"] },
    { id: "public.users", name: "users", schema: "public", displayName: "ユーザー", columns: 5, pk: true, tags: ["core", "auth"], diagrams: ["core"] },
  ],
  relations: [
    { id: "public.orders#fk:orders_user_id_fkey", kind: "physical", from: "public.orders", to: "public.users", columns: [["user_id", "id"]], cardinality: { parent: "1..1", child: "0..N" } },
    { id: "public.orders#lfk:lfk_orders_legacy", kind: "logical", from: "public.orders", to: "public.legacy_orders", columns: [["code", "code"]], cardinality: { parent: "1..1", child: "0..1" }, dangling: true },
    { id: "public.users#fk:users_org_id_fkey", kind: "physical", from: "public.users", to: "public.organizations", columns: [["org_id", "id"]], cardinality: { parent: "0..1", child: "1..N" }, explicit: ["child"] },
    { id: "public.users#lfk:lfk_users_last_order", kind: "logical", from: "public.users", to: "public.orders", columns: [["last_order_id", "id"]], cardinality: { parent: "0..1", child: "0..N" } },
  ],
});
