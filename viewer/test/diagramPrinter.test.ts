/**
 * T-3（INV-3）: Java 実装と TypeScript 実装の出力が一致する。
 * 同じ golden fixture（Java 側が生成・コミットしたもの）を読み、バイト一致を確認する。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { printDiagram, type DiagramPage } from "../src/lib/printer/diagramPrinter";
import { codepointCompare, key, quote } from "../src/lib/printer/jsText";

const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "fixtures");

function read(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

describe("INV-3: diagram printer parity with Java", () => {
  it("core.diagram.model.json → print が core.diagram.js とバイト一致する", () => {
    const model = JSON.parse(read("core.diagram.model.json")) as DiagramPage;
    const printed = printDiagram(model);
    expect(printed).toBe(read("core.diagram.js"));
  });
});

describe("jsText", () => {
  it("予約語・非識別子のキーはクォートされる", () => {
    expect(key("default")).toBe('"default"');
    expect(key("class")).toBe('"class"');
    expect(key("public.users")).toBe('"public.users"');
    expect(key("created_at")).toBe("created_at");
    expect(key("$ok")).toBe("$ok");
  });

  it("日本語はエスケープせず、U+2028 / U+2029 / 制御文字はエスケープする", () => {
    expect(quote("ユーザー")).toBe('"ユーザー"');
    expect(quote("a\u2028b")).toBe('"a\\u2028b"');
    expect(quote("a\u2029b")).toBe('"a\\u2029b"');
    expect(quote('a"b\\c\nd\te')).toBe('"a\\"b\\\\c\\nd\\te"');
    expect(quote("\u0001")).toBe('"\\u0001"');
  });

  it("コードポイント順の比較", () => {
    expect(["b", "a", "c"].sort(codepointCompare)).toEqual(["a", "b", "c"]);
    expect(["public.users", "public.orders"].sort(codepointCompare)).toEqual([
      "public.orders",
      "public.users",
    ]);
  });
});
