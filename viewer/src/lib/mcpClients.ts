/**
 * AI クライアントごとの MCP 設定（Q-01）。
 *
 * **形はツールごとに違う。** 貼り付け先のファイルも、トップレベルのキーも、
 * ヘッダの書き方も揃っていないため、1つの例だけを出すと他のツールの利用者が必ず詰まる。
 * ここは各ツールの公式ドキュメントに合わせた写しであり、変えるときは出典を確認すること。
 *
 * | クライアント | 貼り付け先 | 形 |
 * |---|---|---|
 * | Claude Code | `.mcp.json` | `mcpServers` + `type: "http"` + `headers` |
 * | Codex | `~/.codex/config.toml` | TOML の `[mcp_servers.<id>]` + `http_headers` |
 * | Cursor | `.cursor/mcp.json` | `mcpServers` + `url`（`url` があれば HTTP 扱い。`type` は不要） |
 * | GitHub Copilot (VS Code) | `.vscode/mcp.json` | **`servers`**（`mcpServers` ではない）+ `type: "http"` |
 */

/** サーバー側で登録される名前。どのクライアントでも同じにする */
const SERVER_NAME = "erforge";

export type McpClientId = "claude" | "codex" | "cursor" | "copilot";

/** 貼り付け先の説明に使う翻訳キー（viewerExport の ExportPrefixErrorKey と同じ書き方） */
export type McpWhereKey =
  | "mcp.where.claude"
  | "mcp.where.codex"
  | "mcp.where.cursor"
  | "mcp.where.copilot";

export interface McpClient {
  id: McpClientId;
  /** タブに出す名前。製品名なので翻訳しない（X-02） */
  label: string;
  whereKey: McpWhereKey;
  /** 構文ハイライトはしないが、何の形式かは示す */
  format: "json" | "toml";
  build: (endpoint: string, token: string) => string;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const BY_ID: Record<McpClientId, McpClient> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    whereKey: "mcp.where.claude",
    format: "json",
    build: (endpoint, token) =>
      json({
        mcpServers: {
          [SERVER_NAME]: {
            type: "http",
            url: endpoint,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
  },
  codex: {
    id: "codex",
    label: "Codex",
    whereKey: "mcp.where.codex",
    format: "toml",
    build: (endpoint, token) =>
      [
        `[mcp_servers.${SERVER_NAME}]`,
        `url = "${endpoint}"`,
        `http_headers = { Authorization = "Bearer ${token}" }`,
        "",
      ].join("\n"),
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    whereKey: "mcp.where.cursor",
    format: "json",
    build: (endpoint, token) =>
      json({
        mcpServers: {
          [SERVER_NAME]: {
            url: endpoint,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    whereKey: "mcp.where.copilot",
    format: "json",
    build: (endpoint, token) =>
      json({
        // VS Code のキーは servers（mcpServers ではない）
        servers: {
          [SERVER_NAME]: {
            type: "http",
            url: endpoint,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      }),
  },
};

/** タブに並べる順（既定は Claude Code） */
export const MCP_CLIENTS: McpClient[] = [BY_ID.claude, BY_ID.codex, BY_ID.cursor, BY_ID.copilot];

export function mcpClient(id: McpClientId): McpClient {
  return BY_ID[id];
}

/**
 * 貼り付ける設定を組み立てる。
 *
 * トークンは**発行直後にしか手元に無い**ため、無いときはプレースホルダを入れる
 * （伏字をそのまま貼らせない）。
 */
export function mcpSnippet(
  id: McpClientId,
  endpoint: string,
  token: string,
  placeholder: string,
): string {
  return mcpClient(id).build(endpoint, token === "" ? placeholder : token);
}
