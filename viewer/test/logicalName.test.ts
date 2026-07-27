import { describe, expect, it } from "vitest";
import {
  formatName,
  resolveColumnColor,
  resolveColumnName,
  resolveColumnTags,
  resolveTableName,
} from "../src/model/logicalName";
import type { Dictionary, Table } from "../src/model/types";

const dict: Dictionary = {
  columns: {
    created_at: { displayName: "作成日時", tags: ["監査"], color: "muted" },
    org_id: { displayName: "組織ID" },
    email: { tags: ["pii"], color: "amber" },
  },
};

const table = {
  meta: {
    columns: {
      org_id: { displayName: "所属組織ID" },
      created_at: { tags: ["登録"], color: "blue" },
      email: { tags: ["PII"] },
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

describe("resolveColumnColor (P-13): 個別 → 辞書", () => {
  it("テーブル個別の色が共通色を上書きする", () => {
    expect(resolveColumnColor(table, "created_at", dict)).toEqual({
      color: "blue",
      source: "meta",
    });
  });
  it("個別の色が無ければ共通色が効く", () => {
    expect(resolveColumnColor(table, "email", dict)).toEqual({
      color: "amber",
      source: "dictionary",
    });
  });
  it("どちらにも無ければ未設定", () => {
    expect(resolveColumnColor(table, "org_id", dict)).toEqual({
      color: undefined,
      source: "none",
    });
  });
});

describe("resolveColumnTags (P-12): 辞書 ∪ 個別", () => {
  it("共通タグと個別タグを合成する（共通が先）", () => {
    expect(resolveColumnTags(table, "created_at", dict).tags).toEqual(["監査", "登録"]);
  });
  it("個別に同じタグがあっても表示は1つにまとめる（大小無視・共通が先勝ち）", () => {
    expect(resolveColumnTags(table, "email", dict).tags).toEqual(["pii"]);
  });
  it("共通タグはテーブル未ロード（null）でも効く", () => {
    expect(resolveColumnTags(null, "created_at", dict)).toEqual({
      tags: ["監査"],
      dictionary: ["監査"],
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
