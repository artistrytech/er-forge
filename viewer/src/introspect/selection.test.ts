/** 適用範囲の選択と依存関係の整合（K-10 / 詳細設計 §5.2）。 */
import { describe, expect, it } from "vitest";
import { affectedFileCount, defaultSelection, quickSelect, toggle } from "./selection";
import type { DiffItem } from "./types";

function item(partial: Partial<DiffItem> & Pick<DiffItem, "id" | "change">): DiffItem {
  return {
    kind: "column",
    target: partial.id,
    renamedFrom: null,
    before: null,
    after: null,
    selectable: true,
    requires: [],
    forcedBy: [],
    warnings: [],
    children: [],
    ...partial,
  };
}

/** invoices（新規テーブル）と、それを参照する FK が orders に増えた状況 */
function plan(): DiffItem[] {
  return [
    item({ id: "table:public.invoices", kind: "table", change: "added" }),
    item({
      id: "table:public.orders",
      kind: "table",
      change: "modified",
      selectable: false,
      children: [
        item({ id: "table:public.orders/column:invoice_id", change: "added" }),
        item({
          id: "table:public.orders/fk:orders_invoice_id_fkey",
          kind: "foreignKey",
          change: "added",
          requires: ["table:public.invoices", "table:public.orders/column:invoice_id"],
        }),
        item({ id: "table:public.orders/column:legacy_code", change: "removed" }),
        item({
          id: "table:public.orders/unique:orders_legacy_code_key",
          kind: "unique",
          change: "removed",
          selectable: false,
          forcedBy: ["table:public.orders/column:legacy_code"],
        }),
      ],
    }),
  ];
}

describe("defaultSelection", () => {
  it("既定は全選択（選択可能な項目のみ）", () => {
    const selection = defaultSelection(plan());
    expect(selection.has("table:public.invoices")).toBe(true);
    expect(selection.has("table:public.orders/fk:orders_invoice_id_fkey")).toBe(true);
    // 強制項目（forcedBy）と決定駆動の項目は選択集合に入らない
    expect(selection.has("table:public.orders/unique:orders_legacy_code_key")).toBe(false);
    expect(selection.has("table:public.orders")).toBe(false);
  });
});

describe("toggle", () => {
  it("R-3: 参照先テーブルの追加を外すと、それを requires に持つ FK 追加も外れる", () => {
    const items = plan();
    const next = toggle(items, defaultSelection(items), "table:public.invoices");
    expect(next.has("table:public.invoices")).toBe(false);
    expect(next.has("table:public.orders/fk:orders_invoice_id_fkey")).toBe(false);
    // 無関係な項目は残る
    expect(next.has("table:public.orders/column:invoice_id")).toBe(true);
  });

  it("R-2: FK 追加を選び直すと、前提（参照先テーブル・カラム）も一緒に選ばれる", () => {
    const items = plan();
    let selection = new Set<string>();
    selection = toggle(items, selection, "table:public.orders/fk:orders_invoice_id_fkey");
    expect(selection.has("table:public.invoices")).toBe(true);
    expect(selection.has("table:public.orders/column:invoice_id")).toBe(true);
  });

  it("カラム追加を外すと、それを使う FK 追加も外れる", () => {
    const items = plan();
    const next = toggle(items, defaultSelection(items), "table:public.orders/column:invoice_id");
    expect(next.has("table:public.orders/fk:orders_invoice_id_fkey")).toBe(false);
  });
});

describe("quickSelect", () => {
  it("「追加のみ」は追加テーブルだけを選ぶ", () => {
    const selection = quickSelect(plan(), "addedOnly");
    expect(selection.has("table:public.invoices")).toBe(true);
    expect(selection.has("table:public.orders/column:invoice_id")).toBe(false);
  });

  it("「削除を除く」でも前提は補われる（破綻した選択を作らない）", () => {
    const selection = quickSelect(plan(), "withoutRemoved");
    expect(selection.has("table:public.orders/column:legacy_code")).toBe(false);
    expect(selection.has("table:public.orders/fk:orders_invoice_id_fkey")).toBe(true);
    expect(selection.has("table:public.invoices")).toBe(true);
  });
});

describe("affectedFileCount", () => {
  it("書き換わるファイル数 = テーブル数 + manifest.js + index.js", () => {
    const items = plan();
    expect(affectedFileCount(items, defaultSelection(items))).toBe(4);
    expect(affectedFileCount(items, new Set())).toBe(0);
  });
});
