/**
 * サーバーモードのスモークテスト（Phase2 の完了条件の検証）。
 *
 * 配布物と同じ構成（erd-server.jar + index.html のみ）を一時ディレクトリに作り、
 * 空の状態から:
 * - サーバーを起動して自動発行されたトークン付き URL を開く
 * - ブートストラップ画面が表示される（A-08 / §3.6）
 * - 「サンプルデータを取り込む」→ data/** が書き出され、ER図が描画される
 * - ヘッダの動作モードが「サーバー」になる
 *
 * 前提: `npm run build` と `gradlew shadowJar` が済んでいること。
 * 実行: `npm run e2e:server`（Java は JAVA_HOME または PATH から解決）
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, rmSync } from "node:fs";
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

function javaBin() {
  if (process.env.JAVA_HOME) return join(process.env.JAVA_HOME, "bin", "java");
  return "java";
}

async function main() {
  if (!existsSync(JAR) || !existsSync(INDEX)) {
    console.error("erd-server.jar / dist/index.html がありません。先にビルドしてください。");
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "erd-smoke-"));
  copyFileSync(INDEX, join(dir, "index.html"));

  const proc = spawn(javaBin(), ["-jar", JAR], {
    cwd: dir,
    env: { ...process.env, ERD_NO_BROWSER: "1", ERD_PORT: "5361" },
  });
  let url = null;
  proc.stdout.on("data", (d) => {
    const m = String(d).match(/ERD server: (http:\/\/[^\s]+)/);
    if (m) url = m[1];
  });
  proc.stderr.on("data", () => {});

  try {
    for (let i = 0; i < 100 && url === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    check("server starts and prints tokenized URL", url !== null);
    if (url === null) return;

    let browser;
    for (const channel of ["msedge", "chrome"]) {
      try {
        browser = await chromium.launch({ channel });
        break;
      } catch {
        // 次の channel を試す
      }
    }
    if (!browser) browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    // 1) 空の状態 → ブートストラップ画面
    await page.goto(url);
    await page.waitForSelector(".bootstrap-screen", { timeout: 10000 });
    check("bootstrap screen shows on empty project", true);

    // 2) サンプル取り込み → リロード → ER図描画
    await page.click('[data-testid="bootstrap-sample"]');
    await page.waitForSelector('[data-testid="erd-node"]', { timeout: 20000 });
    check("sample import renders ER diagram", (await page.locator('[data-testid="erd-node"]').count()) > 0);
    check("data files written", existsSync(join(dir, "data", "manifest.js")));
    check("mode badge shows server", await page.locator('[data-testid="mode-badge"][data-mode="server"]').isVisible());
    check("logical (dashed) edges exist on some page",
        existsSync(join(dir, "data", "schema", "public", "point_transactions.js")));

    // 3) 再ロードしても通常表示（ブートストラップは出ない）
    await page.reload();
    await page.waitForSelector('[data-testid="erd-node"]', { timeout: 10000 });
    check("reload shows diagram again", (await page.locator(".bootstrap-screen").count()) === 0);

    await browser.close();
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows ではプロセス終了直後の削除が失敗することがある。一時領域なので放置してよい
    }
  }
}

main().then(
  () => {
    console.log(results.join("\n"));
    console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE OK");
  },
  (e) => {
    console.log(results.join("\n"));
    console.error(e);
    process.exit(1);
  },
);
