/**
 * golden fixture（fixtures/*.js）がビューアの zod スキーマで読めることを検証する。
 * データファイルは「グローバル API への関数呼び出し1つ」なので、
 * ERD スタブを渡して実行し、渡されたオブジェクトを検証する。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isTableKind,
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
      expect(r.data.tables?.length).toBe(4);
      expect(r.data.relations?.some((rel) => rel.kind === "logical")).toBe(true);
      // 解決済みカーディナリティと手動設定の区別（explicit）が読める
      const users = r.data.relations?.find((rel) => rel.id === "public.users#fk:users_org_id_fkey");
      expect(users?.cardinality?.child).toBe("1..N");
      expect(users?.explicit).toEqual(["child"]);
      // オブジェクト種別（K-16）: 通常テーブルは省略され、ビューだけが kind を持つ
      expect(r.data.tables?.find((x) => x.id === "public.users")?.kind).toBeUndefined();
      expect(r.data.tables?.find((x) => x.id === "public.v_active_users")?.kind).toBe("VIEW");
    }
  });
  it("dictionary.js（予約語キー default を含む）", () => {
    const r = zDictionary.safeParse(runFixture("dictionary.js"));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.columns?.["default"]).toEqual({ displayName: "既定値" });
      // 論理名が無くタグ・色だけのエントリも読める（P-12 / P-13）
      expect(r.data.columns?.["deleted_at"]).toEqual({ tags: ["廃止"], color: "muted" });
    }
  });
  it.each(["users.table.js", "orders.table.js", "organizations.table.js", "escape_test.table.js",
    "future.table.js", "v_active_users.table.js"])(
    "%s",
    (file) => {
      const r = zTable.safeParse(runFixture(file));
      expect(r.success).toBe(true);
    },
  );
  it("ビュー（K-16）: kind を読み、通常テーブルは kind を持たない", () => {
    const view = zTable.safeParse(runFixture("v_active_users.table.js"));
    expect(view.success).toBe(true);
    if (view.success) {
      expect(view.data.kind).toBe("VIEW");
      expect(isTableKind(view.data.kind)).toBe(false);
      // ビューは制約を持たない。関係は人が書いた論理外部制約だけ（D-07）
      expect(view.data.primaryKey).toBeUndefined();
      expect(view.data.foreignKeys).toBeUndefined();
      expect(view.data.meta?.logicalForeignKeys?.length).toBe(1);
    }
    const table = zTable.safeParse(runFixture("users.table.js"));
    expect(table.success).toBe(true);
    if (table.success) {
      expect(table.data.kind).toBeUndefined();
      expect(isTableKind(table.data.kind)).toBe(true);
    }
  });
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
