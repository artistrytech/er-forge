ERD.diagram({
  id: "payments",
  title: "決済",
  order: 4,
  nodes: {
    "public.orders": { pos: [80, 200] },
    "public.payment_histories": { pos: [760, 104] },
    "public.payment_methods": { pos: [80, 392] },
    "public.payments": { pos: [392, 200] },
    "public.refunds": { pos: [760, 296] },
  },
});
