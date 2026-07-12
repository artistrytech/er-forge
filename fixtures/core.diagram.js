ERD.diagram({
  id: "core",
  title: "コアドメイン",
  order: 1,
  nodes: {
    "public.orders": { pos: [520, 80] },
    "public.organizations": { pos: [120, 400] },
    "public.users": { pos: [120, 80], w: 260 },
  },
  edges: {
    "public.orders#fk:orders_user_id_fkey": {},
    "public.users#fk:users_org_id_fkey": { waypoints: [[380, 200], [300, 320]] },
  },
});
