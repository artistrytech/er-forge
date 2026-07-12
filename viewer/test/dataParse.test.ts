/**
 * golden fixture（fixtures/*.js）がビューアの zod スキーマで読めることを検証する。
 * データファイルは「グローバル API への関数呼び出し1つ」なので、
 * ERD スタブを渡して実行し、渡されたオブジェクトを検証する。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  zDiagram,
  zDictionary,
  zIndexData,
  zManifest,
  zTable,
} from "../src/model/types";

const FIXTURES = join(__dirname, "..", "..", "fixtures");

function runFixture(file: string): unknown {
  const src = readFileSync(join(FIXTURES, file), "utf-8");
  let payload: unknown;
  const capture = (o: unknown) => {
    payload = o;
  };
  const erd = {
    manifest: capture,
    config: capture,
    index: capture,
    dictionary: capture,
    table: capture,
    diagram: capture,
  };
  new Function("ERD", src)(erd);
  return payload;
}

describe("fixtures をビューアのスキーマで読める", () => {
  it("manifest.js", () => {
    const r = zManifest.safeParse(runFixture("manifest.js"));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.schemaVersion).toBe(1);
  });
  it("index.js", () => {
    const r = zIndexData.safeParse(runFixture("index.js"));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.tables?.length).toBe(3);
      expect(r.data.relations?.some((rel) => rel.kind === "logical")).toBe(true);
      // 解決済みカーディナリティと手動設定の区別（explicit）が読める
      const users = r.data.relations?.find((rel) => rel.id === "public.users#fk:users_org_id_fkey");
      expect(users?.cardinality?.child).toBe("1..N");
      expect(users?.explicit).toEqual(["child"]);
    }
  });
  it("dictionary.js（予約語キー default を含む）", () => {
    const r = zDictionary.safeParse(runFixture("dictionary.js"));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.columns?.["default"]).toBe("既定値");
  });
  it.each(["users.table.js", "orders.table.js", "organizations.table.js", "escape_test.table.js", "future.table.js"])(
    "%s",
    (file) => {
      const r = zTable.safeParse(runFixture(file));
      expect(r.success).toBe(true);
    },
  );
  it("未知キー（future.table.js）を捨てずに保持する", () => {
    const r = zTable.safeParse(runFixture("future.table.js"));
    expect(r.success).toBe(true);
  });
  it("core.diagram.js", () => {
    const r = zDiagram.safeParse(runFixture("core.diagram.js"));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nodes?.["public.users"]?.pos).toEqual([120, 80]);
      expect(r.data.nodes?.["public.users"]?.w).toBe(260);
      expect(
        r.data.edges?.["public.users#fk:users_org_id_fkey"]?.waypoints,
      ).toEqual([[380, 200], [300, 320]]);
    }
  });
});
