/**
 * AI クライアントへ貼り付ける設定（Q-01）。
 *
 * この文字列はそのまま `.mcp.json` に貼られるため、形が崩れると接続できない。
 * トークンは発行直後にしか手に入らないので、無いときはプレースホルダで出す。
 */
import { describe, expect, it } from "vitest";
import { mcpSnippet } from "../src/ui/McpDialog";

const ENDPOINT = "http://127.0.0.1:5321/__erd/mcp";
const PLACEHOLDER = "<発行したトークン>";

describe("mcpSnippet", () => {
  it("そのまま .mcp.json に貼れる形になる", () => {
    const parsed = JSON.parse(mcpSnippet(ENDPOINT, "abc123", PLACEHOLDER));
    expect(parsed).toEqual({
      mcpServers: {
        erforge: {
          type: "http",
          url: ENDPOINT,
          headers: { Authorization: "Bearer abc123" },
        },
      },
    });
  });

  it("サーバーが返した実ポートをそのまま使う（起動ごとに変わりうる）", () => {
    const snippet = mcpSnippet("http://127.0.0.1:5327/__erd/mcp", "t", PLACEHOLDER);
    expect(snippet).toContain("http://127.0.0.1:5327/__erd/mcp");
  });

  it("トークンが手元に無いときはプレースホルダを入れる（伏字を貼らせない）", () => {
    const snippet = mcpSnippet(ENDPOINT, "", PLACEHOLDER);
    expect(snippet).toContain(`Bearer ${PLACEHOLDER}`);
    expect(snippet).not.toContain("…");
  });
});
