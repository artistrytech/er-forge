import { beforeEach, describe, expect, it } from "vitest";
import { hrefs, parseHash, workspaceIdFromHash } from "../src/ui/router";
import { setCurrentWorkspaceId } from "../src/model/workspace";

describe("parseHash (B-07 / 設計書 §4.4)", () => {
  it("空・#/ はホーム", () => {
    expect(parseHash("")).toEqual({ kind: "home" });
    expect(parseHash("#/")).toEqual({ kind: "home" });
  });
  it("#/erd/<id>", () => {
    expect(parseHash("#/erd/core")).toEqual({ kind: "erd", diagramId: "core" });
  });
  it("#/erd/<id>/<tableId>", () => {
    expect(parseHash("#/erd/core/public.users")).toEqual({
      kind: "erd",
      diagramId: "core",
      tableId: "public.users",
    });
  });
  // 編集中に左パネルからテーブルを選んでも編集を抜けないよう、編集ルートも
  // フォーカス先を持てる（#/erd/<id>/edit/<tableId>）
  it("#/erd/<id>/edit（フォーカスの有無）", () => {
    expect(parseHash("#/erd/core/edit")).toEqual({ kind: "erdEdit", diagramId: "core" });
    expect(parseHash("#/erd/core/edit/public.users")).toEqual({
      kind: "erdEdit",
      diagramId: "core",
      tableId: "public.users",
    });
  });
  it("#/tables 系", () => {
    expect(parseHash("#/tables")).toEqual({ kind: "tables" });
    expect(parseHash("#/tables/public.users")).toEqual({
      kind: "table",
      tableId: "public.users",
    });
    expect(parseHash("#/tables/public.users/edit")).toEqual({
      kind: "tableEdit",
      tableId: "public.users",
    });
  });
  it("#/columns", () => {
    expect(parseHash("#/columns")).toEqual({ kind: "columns" });
  });
  // ページが1枚も無いとき（逆生成の直後）の着地点。ここが notFound だと、
  // ページを作る画面に到達できず行き止まりになる（I-01）
  it("#/erd（ページ未指定）は ER図 のホーム", () => {
    expect(parseHash("#/erd")).toEqual({ kind: "erdHome" });
    expect(parseHash(hrefs.erdHome())).toEqual({ kind: "erdHome" });
  });

  it("未知のルートは notFound（白画面にしない。B-11）", () => {
    expect(parseHash("#/unknown/x")).toEqual({ kind: "notFound", path: "/unknown/x" });
    expect(parseHash("#/tables/a/b")).toEqual({ kind: "notFound", path: "/tables/a/b" });
  });
  it("hrefs と parseHash が往復する（URI エンコード込み）", () => {
    const id = "public.注文";
    expect(parseHash(hrefs.table(id))).toEqual({ kind: "table", tableId: id });
    expect(parseHash(hrefs.erd("core", id))).toEqual({
      kind: "erd",
      diagramId: "core",
      tableId: id,
    });
  });
});

describe("ワークスペース接頭辞（#/w/<id>）", () => {
  beforeEach(() => {
    setCurrentWorkspaceId("sales");
  });

  it("hrefs は現在のワークスペースを URL に含める", () => {
    expect(hrefs.erd("core")).toBe("#/w/sales/erd/core");
    expect(hrefs.tables()).toBe("#/w/sales/tables");
    expect(hrefs.columnsEdit()).toBe("#/w/sales/columns/edit");
    expect(hrefs.workspace("billing")).toBe("#/w/billing/erd");
  });

  it("parseHash はワークスペース部を落として画面を解釈する", () => {
    expect(parseHash("#/w/sales/erd/core")).toEqual({ kind: "erd", diagramId: "core" });
    expect(parseHash("#/w/sales/erd")).toEqual({ kind: "erdHome" });
    expect(parseHash("#/w/sales")).toEqual({ kind: "home" });
    // ワークスペース部が無い URL も従来どおり解釈できる（ローダーが補って書き換える）
    expect(parseHash("#/erd/core")).toEqual({ kind: "erd", diagramId: "core" });
  });

  it("workspaceIdFromHash は URL のワークスペースを返す（不正な ID は無視）", () => {
    expect(workspaceIdFromHash("#/w/sales/erd/core")).toBe("sales");
    expect(workspaceIdFromHash("#/erd/core")).toBeNull();
    expect(workspaceIdFromHash("#/w/bad id/erd")).toBeNull();
  });

  it("往復する（ワークスペース込み）", () => {
    expect(parseHash(hrefs.erdEdit("core"))).toEqual({ kind: "erdEdit", diagramId: "core" });
    expect(parseHash(hrefs.erdEdit("core", "public.注文"))).toEqual({
      kind: "erdEdit",
      diagramId: "core",
      tableId: "public.注文",
    });
    expect(parseHash(hrefs.introspect())).toEqual({ kind: "introspect" });
  });
});
