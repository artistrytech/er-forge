ERD.diagram({
  id: "billing",
  title: "課金",
  order: 2,
  nodes: {
    "public.order_items": { pos: [400, 240] },
    "public.orders": { pos: [80, 80] },
    "public.products": { pos: [720, 80] },
  },
  edges: {
    "public.order_items#fk:order_items_order_id_fkey": {},
    "public.order_items#fk:order_items_product_id_fkey": {},
  },
});
