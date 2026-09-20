/**
 * MCP 連携（Q-01 / Q-02）のスモークテスト。
 *
 * 配布物と同じ構成（erd-server.jar + index.html + データ）で起動し、**画面の操作だけで**
 * 接続できるところまでを通しで確かめる:
 * - 歯車 → AI 連携（MCP）が出る（サーバーモードのみ）
 * - 有効化 → トークン発行 → 貼り付ける設定に**実ポートと生トークン**が埋まる
 * - **その設定でそのまま `POST /__erd/mcp` が通り**、読み取りツールが見える
 *
 * 最後の1点がこのテストの主眼である。画面・トークン・エンドポイントのどれかがずれていても
 * 画面上は正常に見えてしまい、利用者は「貼ったのに繋がらない」としか分からないため。
 *
 * 前提: `npm run build` と `gradlew shadowJar` が済んでいること。
 * 実行: `npm run e2e:mcp`（Java は JAVA_HOME または PATH から解決）
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const JAR = resolve(here, "..", "..", "server", "build", "libs", "erd-server.jar");
const INDEX = resolve(here, "..", "dist", "index.html");
/** 開発用プロジェクト（サンプル取り込み済み）。無ければブートストラップから作る手間を省くため必須にする */
const DEV = resolve(here, "..", "..", "dev");

const results = [];
function check(name, cond) {
  results.push(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond) process.exitCode = 1;
}

function javaBin() {
  return process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";
}

async function main() {
  if (!existsSync(JAR) || !existsSync(INDEX)) {
    console.error("erd-server.jar / dist/index.html がありません。先にビルドしてください。");
    process.exit(1);
  }
  if (!existsSync(join(DEV, "workspaces.js"))) {
    console.error("dev/ にデータがありません。gradlew devServer でサンプルを取り込んでください。");
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), "erd-mcp-"));
  copyFileSync(INDEX, join(dir, "index.html"));
  for (const name of ["workspaces.js", "workspace-default"]) {
    const src = join(DEV, name);
    if (existsSync(src)) cpSync(src, join(dir, name), { recursive: true });
  }

  const proc = spawn(javaBin(), ["-jar", JAR], {
    cwd: dir,
    env: { ...process.env, ERD_NO_BROWSER: "1", ERD_PORT: "5372" },
  });
  let url = null;
  proc.stdout.on("data", (d) => {
    const m = String(d).match(/ERD server: (http:\/\/[^\s]+)/);
    if (m) url = m[1];
  });
  proc.stderr.on("data", () => {});

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 150 && url === null; i++) await new Promise((r) => setTimeout(r, 100));
    check("server starts", url !== null);
    if (url === null) return;

    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(url);
    await page.waitForSelector('[data-testid="settings-button"]', { timeout: 20000 });

    await page.getByTestId("settings-button").click();
    const entry = page.getByTestId("mcp-settings");
    check("設定メニューに AI 連携（MCP）が出る", await entry.isVisible());
    await entry.click();

    await page.getByTestId("mcp-token-state").waitFor();
    check("最初は未発行", (await page.getByTestId("mcp-token-state").innerText()).includes("未発行"));

    // 有効化 → 発行。どちらもサーバーへの PUT なので、状態は応答を受けてから反映される
    await page.getByTestId("mcp-enabled").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="mcp-enabled"]').checked,
    );
    await page.getByTestId("mcp-token-issue").click();
    await page.getByTestId("mcp-token-once").waitFor();

    const snippet = await page.getByTestId("mcp-snippet").inputValue();
    const port = new URL(url).port;
    check("スニペットに実ポートが入る", snippet.includes(port));
    check("スニペットに生トークンが入る", /Bearer [0-9a-f]{64}/.test(snippet));
    check("プレースホルダが残っていない", !snippet.includes("発行したトークン"));

    // クライアントごとにタブを切り替えると、形と貼り付け先が入れ替わる
    await page.getByTestId("mcp-client-copilot").click();
    const copilot = await page.getByTestId("mcp-snippet").inputValue();
    check("Copilot: トップレベルが servers", JSON.parse(copilot).servers !== undefined);
    check("Copilot: mcpServers ではない", JSON.parse(copilot).mcpServers === undefined);
    check(
      "Copilot: 貼り付け先が .vscode/mcp.json",
      (await page.getByTestId("mcp-snippet-where").innerText()).includes(".vscode/mcp.json"),
    );

    await page.getByTestId("mcp-client-codex").click();
    const codex = await page.getByTestId("mcp-snippet").inputValue();
    check("Codex: TOML になる", codex.includes("[mcp_servers.erforge]"));
    check("Codex: http_headers で渡す", codex.includes("http_headers = { Authorization ="));

    await page.getByTestId("mcp-client-cursor").click();
    const cursor = JSON.parse(await page.getByTestId("mcp-snippet").inputValue());
    check("Cursor: type を付けない（url があれば HTTP）", cursor.mcpServers.erforge.type === undefined);

    await page.getByTestId("mcp-client-claude").click();

    // 画面が案内したとおりの設定で、実際に MCP が喋れるか
    const token = snippet.match(/Bearer ([0-9a-f]{64})/)[1];
    const origin = new URL(url).origin;
    const list = await page.request.post(`${origin}/__erd/mcp`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    const listBody = await list.json();
    check("発行したトークンで tools/list が通る", list.status() === 200);
    check("読み取り8種が見える", listBody.result?.tools?.length === 8);

    // 書き込みを許可していないので、書き込みツールは1つも出てはならない（INV-6）
    const names = (listBody.result?.tools ?? []).map((t) => t.name);
    check(
      "書き込みツールが混ざっていない",
      names.every((n) => n.startsWith("erd_list") || n.startsWith("erd_get") || n === "erd_search"),
    );

    // modern（2026-07-28）で来たときの形。ここが崩れるとクライアントのスキーマ検証で落ち、
    // 「接続はできているのにツールが取れない」という分かりにくい壊れ方をする
    const modernList = await page.request.post(`${origin}/__erd/mcp`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      data: {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "smoke", version: "1.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
    });
    const modernBody = (await modernList.json()).result ?? {};
    check("modern: resultType が complete", modernBody.resultType === "complete");
    check("modern: ttlMs が 0 以上の整数", Number.isInteger(modernBody.ttlMs) && modernBody.ttlMs >= 0);
    check("modern: cacheScope が public / private", ["public", "private"].includes(modernBody.cacheScope));

    // 実データが引けるか（ツールがサーバーの data/** を本当に読んでいるか）
    const call = await page.request.post(`${origin}/__erd/mcp`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "erd_list_tables", arguments: {} },
      },
    });
    const callBody = await call.json();
    const text = callBody.result?.content?.[0]?.text ?? "";
    check("tools/call がテーブル一覧を返す", text.includes("public."));
    check("isError が立っていない", callBody.result?.isError === false);

    // セッショントークンでは MCP を叩けない（INV-3）
    const wrong = await page.request.post(`${origin}/__erd/mcp`, {
      headers: {
        Authorization: `Bearer ${new URL(url).searchParams.get("t")}`,
        "Content-Type": "application/json",
      },
      data: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      failOnStatusCode: false,
    });
    check("セッショントークンでは通らない", wrong.status() === 403);
  } finally {
    await browser.close();
    proc.kill();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => console.log(results.join("\n")));
