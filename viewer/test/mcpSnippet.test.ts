/**
 * AI クライアントへ貼り付ける設定（Q-01）。
 *
 * この文字列はそのまま各ツールの設定ファイルに貼られるため、形が崩れると接続できない。
 * **形はツールごとに違う**（トップレベルのキーも、ヘッダの書き方も、ファイル形式も揃っていない）ので、
 * ここは各ツールの公式ドキュメントに合わせた写しである。変えるときは出典を確認すること。
 *
 * トークンは発行直後にしか手に入らないので、無いときはプレースホルダで出す。
 */
import { describe, expect, it } from "vitest";
import { MCP_CLIENTS, mcpSnippet, type McpClientId } from "../src/lib/mcpClients";

const ENDPOINT = "http://127.0.0.1:5321/__erd/mcp";
const PLACEHOLDER = "<発行したトークン>";
const TOKEN = "abc123";

const snippetOf = (id: McpClientId) => mcpSnippet(id, ENDPOINT, TOKEN, PLACEHOLDER);

describe("mcpSnippet", () => {
  it("Claude Code: mcpServers + type:http + headers", () => {
    expect(JSON.parse(snippetOf("claude"))).toEqual({
      mcpServers: {
        erforge: {
          type: "http",
          url: ENDPOINT,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    });
  });

  it("Cursor: url があれば HTTP 扱いになるので type を付けない", () => {
    expect(JSON.parse(snippetOf("cursor"))).toEqual({
      mcpServers: {
        erforge: { url: ENDPOINT, headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    });
  });

  it("GitHub Copilot: トップレベルは servers（mcpServers ではない）", () => {
    const parsed = JSON.parse(snippetOf("copilot"));
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed).toEqual({
      servers: {
        erforge: {
          type: "http",
          url: ENDPOINT,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    });
  });

  it("Codex: TOML の [mcp_servers.<id>] と http_headers", () => {
    const toml = snippetOf("codex");
    expect(toml).toContain("[mcp_servers.erforge]");
    expect(toml).toContain(`url = "${ENDPOINT}"`);
    expect(toml).toContain(`http_headers = { Authorization = "Bearer ${TOKEN}" }`);
  });

  it("どのクライアントでも、実ポートとトークンが必ず入る", () => {
    for (const client of MCP_CLIENTS) {
      const snippet = mcpSnippet(client.id, "http://127.0.0.1:5327/__erd/mcp", TOKEN, PLACEHOLDER);
      expect(snippet, client.id).toContain("http://127.0.0.1:5327/__erd/mcp");
      expect(snippet, client.id).toContain(TOKEN);
    }
  });

  it("トークンが手元に無いときはプレースホルダを入れる（伏字を貼らせない）", () => {
    for (const client of MCP_CLIENTS) {
      const snippet = mcpSnippet(client.id, ENDPOINT, "", PLACEHOLDER);
      expect(snippet, client.id).toContain(PLACEHOLDER);
      expect(snippet, client.id).not.toContain("…");
    }
  });
});
