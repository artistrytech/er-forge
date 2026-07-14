import { describe, expect, it } from "vitest";
import { hrefs, parseHash } from "../src/ui/router";

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
