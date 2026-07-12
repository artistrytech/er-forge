ERD.manifest({
  schemaVersion: 1,
  generatedAt: "2026-07-12T00:00:00Z",
  source: { product: "PostgreSQL", version: "16.2" },
  config: "config.js",
  dictionary: "dictionary.js",
  tables: {
    "public.audit_logs": "schema/public/audit_logs.js",
    "public.order_items": "schema/public/order_items.js",
    "public.orders": "schema/public/orders.js",
    "public.organizations": "schema/public/organizations.js",
    "public.products": "schema/public/products.js",
    "public.users": "schema/public/users.js",
  },
  diagrams: [
    { id: "core", file: "diagrams/core.js", title: "コアドメイン", order: 1 },
    { id: "billing", file: "diagrams/billing.js", title: "課金", order: 2 },
  ],
});
