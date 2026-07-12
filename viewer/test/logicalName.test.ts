import { describe, expect, it } from "vitest";
import {
  formatName,
  resolveColumnName,
  resolveTableName,
} from "../src/model/logicalName";
import type { Dictionary, Table } from "../src/model/types";

const dict: Dictionary = { columns: { created_at: "作成日時", org_id: "組織ID" } };

const table = {
  meta: {
    columns: {
      org_id: { displayName: "所属組織ID" },
    },
  },
} as unknown as Table;

describe("resolveTableName (P-05)", () => {
  it("meta.displayName を優先する", () => {
    expect(resolveTableName("users", "ユーザー")).toEqual({ name: "ユーザー", source: "meta" });
  });
  it("未設定なら物理名にフォールバックする", () => {
    expect(resolveTableName("users", undefined)).toEqual({ name: "users", source: "physical" });
  });
  it("空文字は未設定として扱う", () => {
    expect(resolveTableName("users", "")).toEqual({ name: "users", source: "physical" });
  });
});

describe("resolveColumnName (P-05): 個別 → 辞書 → 物理名", () => {
  it("テーブル個別設定が辞書より優先される", () => {
    expect(resolveColumnName(table, "org_id", dict)).toEqual({
      name: "所属組織ID",
      source: "meta",
    });
  });
  it("個別設定がなければ辞書を使う", () => {
    expect(resolveColumnName(table, "created_at", dict)).toEqual({
      name: "作成日時",
      source: "dictionary",
    });
  });
  it("どちらにもなければ物理名", () => {
    expect(resolveColumnName(table, "email", dict)).toEqual({
      name: "email",
      source: "physical",
    });
  });
  it("テーブル未ロード（null）でも辞書は効く", () => {
    expect(resolveColumnName(null, "created_at", dict)).toEqual({
      name: "作成日時",
      source: "dictionary",
    });
  });
});

describe("formatName（表示切替）", () => {
  const resolved = { name: "ユーザー", source: "meta" as const };
  it("併記は「論理名 (物理名)」", () => {
    expect(formatName(resolved, "users", "both")).toBe("ユーザー (users)");
  });
  it("論理名のみ", () => {
    expect(formatName(resolved, "users", "logical")).toBe("ユーザー");
  });
  it("物理名のみ", () => {
    expect(formatName(resolved, "users", "physical")).toBe("users");
  });
  it("未解決（物理名フォールバック）は併記でも物理名のみ", () => {
    expect(formatName({ name: "users", source: "physical" }, "users", "both")).toBe("users");
  });
});
