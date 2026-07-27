/**
 * テーブル編集・論理名・論理制約のスモークテスト（Phase4 の完了条件の検証）。
 *
 * - サンプルデータを取り込み、テーブル編集画面（O-03）を開く（ロック自動取得）
 * - テーブル論理名を変更し、論理外部制約（P-07）を追加して保存
 *   → schema/**.js に meta が書かれ、index.js が再生成される（P §4.3）
 *   → ER図に破線エッジが1本増える（E-09。Phase4 の完了条件）
 * - カラム論理名の一括編集画面（P-03）で辞書を編集して保存
 *   → dictionary.js が更新される
 *
 * 前提: `npm run build` と `gradlew shadowJar` 済み。実行: `node e2e/meta-edit-smoke.mjs`
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const JAR = resolve(here, "..", "..", "server", "build", "libs", "erd-server.jar");
const INDEX = resolve(here, "..", "dist", "index.html");

const results = [];
function check(name, cond) {
  results.push(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond) process.exitCode = 1;
}

/**
 * 制御コンポーネントへの入力は実際のキー入力で行う。
 * locator.fill() は value を直接書き換えるため React の onChange が発火しない。
 */
async function typeInto(locator, text) {
  await locator.click();
  await locator.press("ControlOrMeta+a");
  await locator.pressSequentially(text);
}

function javaBin() {
  if (process.env.JAVA_HOME) return join(process.env.JAVA_HOME, "bin", "java");
  return "java";
}

async function main() {
  if (!existsSync(JAR) || !existsSync(INDEX)) {
    console.error("erd-server.jar / dist/index.html がありません。先にビルドしてください。");
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "erd-meta-"));
  copyFileSync(INDEX, join(dir, "index.html"));
  // ワークスペースを1つ用意しておく（サーバーは起動時に workspace-* を走査して認識する）
  mkdirSync(join(dir, "workspace-default", "data"), { recursive: true });

  const proc = spawn(javaBin(), ["-jar", JAR], {
    cwd: dir,
    env: { ...process.env, ERD_NO_BROWSER: "1", ERD_PORT: "5391" },
  });
  let url = null;
  proc.stdout.on("data", (d) => {
    const m = String(d).match(/ERD server: (http:\/\/[^\s]+)/);
    if (m) url = m[1];
  });
  proc.stderr.on("data", () => {});

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 100 && url === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    check("server starts", url !== null);
    if (url === null) return;

    // サンプルデータの取り込み（A-08）。UI を経ずに API で初期化する
    const token = new URL(url).searchParams.get("t");
    const origin = new URL(url).origin;
    const boot = await fetch(`${origin}/__erd/w/default/bootstrap?t=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "sample" }),
    });
    check("sample bootstrap succeeds", boot.status === 200);

    const page = await browser.newPage();

    // ---- ベースライン: users ページの破線エッジ数 ----
    await page.goto(`${url}#/w/default/erd/users`);
    await page.waitForSelector(".react-flow__node", { timeout: 15000 });
    const logicalBefore = await page.locator('[data-testid="erd-edge"][data-kind="logical"]').count();

    // ---- テーブル編集画面（O-03）: 論理名 + 論理外部制約を保存 ----
    await page.goto(`${url}#/w/default/tables/public.user_sessions/edit`);
    await page.waitForFunction(
      () => {
        const f = document.querySelector("fieldset.edit-form");
        return f !== null && !f.disabled;
      },
      null,
      { timeout: 15000 },
    );
    check("edit form is enabled on the edit route (no lock)", true);

    await typeInto(page.locator(".form-grid input").first(), "セッション");

    await page.getByRole("button", { name: "+ 論理外部制約を追加" }).click();
    const row = page.locator(".constraint-row").last();
    await row.locator("select").nth(0).selectOption("user_id"); // 参照元カラム
    await row.locator("select").nth(1).selectOption("public.user_profiles"); // 参照先テーブル
    await row.locator("select").nth(2).selectOption("id"); // 参照先カラム

    // 保存はヘッダの保存アイコンから（変更があると活性化する）。保存後も編集は継続する
    await page.waitForSelector('[data-testid="save-button"]:not([disabled])', { timeout: 15000 });
    await page.getByTestId("save-button").click();
    // 保存が済むと未保存フラグが落ち、保存アイコンが saved（非活性）に戻る
    await page.waitForSelector('[data-testid="save-button"][data-status="saved"]', { timeout: 15000 });
    const stillEditing = (await page.evaluate(() => location.hash)) === "#/w/default/tables/public.user_sessions/edit";
    check("save persists and stays in edit mode", stillEditing);

    const schemaText = readFileSync(
      join(dir, "workspace-default", "data", "schema", "public", "user_sessions.js"),
      "utf-8",
    );
    check("schema file contains the new displayName", schemaText.includes('displayName: "セッション"'));
    check(
      "schema file contains the auto-named logical FK",
      schemaText.includes("lfk_user_sessions_user_id") &&
        schemaText.includes('table: "public.user_profiles"'),
    );

    const indexText = readFileSync(join(dir, "workspace-default", "data", "index.js"), "utf-8");
    check(
      "index.js is regenerated with the lfk edge (P §4.3)",
      indexText.includes("public.user_sessions#lfk:lfk_user_sessions_user_id"),
    );

    // ---- タグ（P-12）と色（P-13）: 空白で確定、色はタグとは独立に指定する ----
    const tagInput = page.getByTestId("table-tags");
    // サンプルの user_sessions には既に "auth" が付いている（chip 1件が初期状態）
    const chipCount = () => page.getByTestId("tag-chip").count();
    check("existing tags are shown as chips", (await chipCount()) === 1);

    await tagInput.click();
    // 半角スペースで "core" が確定し、"廃止" は未確定のまま入力欄に残る
    await tagInput.pressSequentially("core 廃止");
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="tag-chip"]').length === 2,
      null,
      { timeout: 5000 },
    );
    check("a space confirms the tag as a chip", true);

    // 色を選ぶ操作でタグ入力から抜ける → 未確定の "廃止" は暗黙確定される
    await page.getByTestId("table-color").getByTestId("color-muted").click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="tag-chip"]').length === 3,
      null,
      { timeout: 5000 },
    );
    check("the pending text is committed on blur", true);

    await page.waitForSelector('[data-testid="save-button"]:not([disabled])', { timeout: 15000 });
    await page.getByTestId("save-button").click();
    await page.waitForSelector('[data-testid="save-button"][data-status="saved"]', { timeout: 15000 });

    const taggedText = readFileSync(
      join(dir, "workspace-default", "data", "schema", "public", "user_sessions.js"),
      "utf-8",
    );
    check("tags and color are saved independently", taggedText.includes('tags: ["auth", "core", "廃止"]')
      && taggedText.includes('color: "muted"'));
    const indexAfterColor = readFileSync(join(dir, "workspace-default", "data", "index.js"), "utf-8");
    const sessionsEntry = indexAfterColor
      .split("\n")
      .find((line) => line.includes('id: "public.user_sessions"'));
    check(
      "index.js carries the color (the canvas draws nodes from index.js alone)",
      sessionsEntry !== undefined && sessionsEntry.includes('color: "muted"'),
    );
    check("index.js lists the tags in use (autocomplete source)", indexAfterColor.includes("tagsUsed:"));

    // ---- ER図に破線エッジが増える（Phase4 の完了条件） ----
    await page.goto(`${url}#/w/default/erd/users`);
    await page.waitForSelector(".react-flow__node", { timeout: 15000 });
    await page.waitForFunction(
      (before) => document.querySelectorAll('[data-testid="erd-edge"][data-kind="logical"]').length === before + 1,
      logicalBefore,
      { timeout: 15000 },
    );
    check("a dashed edge appears on the diagram", true);

    // 指定色はノードに反映される（D-03）。左パネルの行も同じ色になる
    const coloredNodes = await page.locator('[data-testid="erd-node"][data-color="muted"]').count();
    check("the node is painted with the specified color", coloredNodes === 1);
    const coloredRows = await page.locator('[data-testid="lp-item"][data-color="muted"]').count();
    check("the table list row uses the same color as the node", coloredRows >= 1);

    // ---- カラム論理名の一括編集（P-03） ----
    // 閲覧は #/columns、編集は #/columns/edit（ロックは無い。P-03 §2.4）
    await page.goto(`${url}#/w/default/columns/edit`);
    // 全テーブルのロード完了で保存が有効化されるまで編集
    const rowInput = page
      .locator("tr", { has: page.locator("td", { hasText: "session_token" }) })
      .locator("input");
    await typeInto(rowInput, "セッショントークン");
    // 保存はヘッダの保存アイコン。全テーブルのロード完了で活性化するまで待ってから押す
    await page.waitForSelector('[data-testid="save-button"]:not([disabled])', { timeout: 20000 });
    await page.getByTestId("save-button").click();
    // 保存が済むと dirty マークが消える（辞書は index.js を再生成しない。P §4.3）
    await page.waitForFunction(
      () => document.querySelectorAll(".columns-table .row-dirty").length === 0,
      null,
      { timeout: 15000 },
    );
    const dictText = readFileSync(join(dir, "workspace-default", "data", "dictionary.js"), "utf-8");
    check("dictionary.js is updated by bulk edit", dictText.includes("セッショントークン"));

    await page.close();
  } catch (e) {
    check(`no unexpected error (${e.message})`, false);
  } finally {
    await browser.close();
    proc.kill();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows ではプロセス終了直後の削除が失敗することがある
    }
    console.log(results.join("\n"));
  }
}

await main();
