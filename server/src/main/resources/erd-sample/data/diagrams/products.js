ERD.diagram({
  id: "products",
  title: "商品管理",
  order: 2,
  nodes: {
    "public.inventories": { pos: [760, 200] },
    "public.product_categories": { pos: [80, 200] },
    "public.product_images": { pos: [760, 56] },
    "public.product_reviews": { pos: [760, 344] },
    "public.product_tag_mappings": { pos: [392, 488] },
    "public.product_tags": { pos: [80, 488] },
    "public.products": { pos: [392, 200] },
    "public.users": { pos: [1080, 488] },
  },
});
