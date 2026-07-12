ERD.manifest({
  schemaVersion: 1,
  generatedAt: "2026-07-12T00:00:00Z",
  source: { product: "PostgreSQL", version: "16.2" },
  config: "config.js",
  dictionary: "dictionary.js",
  tables: {
    "public.orders": "schema/public/orders.js",
    "public.organizations": "schema/public/organizations.js",
    "public.users": "schema/public/users.js",
  },
  diagrams: [
    { id: "core", file: "diagrams/core.js", title: "コアドメイン", order: 1 },
  ],
});
