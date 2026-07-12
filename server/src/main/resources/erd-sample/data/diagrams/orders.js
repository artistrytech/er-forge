ERD.diagram({
  id: "orders",
  title: "注文管理",
  order: 3,
  nodes: {
    "public.inventories": { pos: [1080, 200] },
    "public.order_cancellations": { pos: [760, 488] },
    "public.order_items": { pos: [760, 56] },
    "public.order_status_logs": { pos: [760, 344] },
    "public.orders": { pos: [392, 200] },
    "public.products": { pos: [1080, 56] },
    "public.shipments": { pos: [760, 200] },
    "public.users": { pos: [80, 200] },
  },
});
