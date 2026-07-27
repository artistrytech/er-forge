/** タグの正規化・分割・検証（P-12）。サーバー側 MetaRules と同じ規則であること。 */
import { describe, expect, it } from "vitest";
import { normalizeTags, splitTagInput, tagError } from "../src/model/metaRules";

describe("normalizeTags", () => {
  it("前後空白を落とし、空要素を捨て、大小無視で重複を除く（先勝ち）", () => {
    expect(normalizeTags([" core ", "", "Core", "auth", "AUTH"])).toEqual(["core", "auth"]);
  });

  it("入力順を保つ（タグの順序に意味は無いが、人の書いた順を変えない）", () => {
    expect(normalizeTags(["廃止", "core"])).toEqual(["廃止", "core"]);
  });
});

describe("splitTagInput", () => {
  it("空白・カンマ・読点で分割する（貼り付けと手入力の結果を揃える）", () => {
    expect(splitTagInput("core, auth 廃止、pii")).toEqual(["core", "auth", "廃止", "pii"]);
  });

  it("全角スペースでも分割する（日本語入力では全角が出やすい）", () => {
    expect(splitTagInput("core　auth")).toEqual(["core", "auth"]);
  });
});

describe("tagError", () => {
  it("32文字を超えるとエラー", () => {
    expect(tagError("あ".repeat(32), [])).toBeNull();
    expect(tagError("あ".repeat(33), [])).toBe("TAG_TOO_LONG");
  });

  it("既存タグとの重複は大小を無視して検出する", () => {
    expect(tagError("Core", ["core"])).toBe("TAG_DUPLICATE");
  });
});
