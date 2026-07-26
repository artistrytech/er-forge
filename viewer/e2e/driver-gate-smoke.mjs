/**
 * ドライバゲートのスモーク（§7.2）。DB は不要（ゲートは /__erd/drivers の応答だけで決まる）。
 *  1. ドライバも設定も無い新規プロジェクト → setup ゲートが逆生成画面を塞ぐ
 *  2. ゲートが出ている間は逆生成の実行ボタンが押せない（操作ブロック）
 *  3. PostgreSQL を選んで「設定して取得」→ Maven からDL → ゲートが消える
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const JAR = join(ROOT, "server", "build", "libs", "erd-server.jar");
const INDEX = join(here, "..", "dist", "index.html");

function javaBin() {
  const home = process.env.JAVA_HOME;
  return home ? join(home, "bin", "java") : "java";
}

let passed = 0;
let failed = 0;
function check(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (ok) passed++;
  else failed++;
}

async function main() {
  if (!existsSync(JAR) || !existsSync(INDEX)) {
    console.error("erd-server.jar / dist/index.html がありません。先にビルドしてください。");
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "erd-gate-"));
  copyFileSync(INDEX, join(dir, "index.html"));
  // ワークスペースを1つ用意しておく（サーバーは起動時に workspace-* を走査して認識する）
  mkdirSync(join(dir, "workspace-default", "data"), { recursive: true });
  mkdirSync(join(dir, "drivers")); // 空。config も無い → setup ゲート

  const proc = spawn(javaBin(), ["-jar", JAR], {
    cwd: dir,
    env: { ...process.env, ERD_NO_BROWSER: "1", ERD_PORT: "5394" },
  });
  let url = null;
  proc.stdout.on("data", (d) => {
    const m = String(d).match(/ERD server: (http:\/\/[^\s]+)/);
    if (m) url = m[1];
  });
  proc.stderr.on("data", () => {});

  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 100 && url === null; i++) await new Promise((r) => setTimeout(r, 100));
    check("server starts", url !== null);
    if (url === null) return;

    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForSelector(".bootstrap-screen", { timeout: 15000 });
    await page.getByRole("link", { name: "既存のスキーマから生成する" }).click();
    await page.waitForSelector('[data-testid="introspect-page"]', { timeout: 15000 });

    // 1) ドライバも設定も無い → setup ゲートが出る
    await page.waitForSelector('[data-testid="driver-gate"]', { timeout: 15000 });
    const gateSetup = await page.getByTestId("gate-setup").count();
    check("driver gate (setup) blocks the screen when no driver is configured", gateSetup === 1);

    // 2) ゲート表示中は逆生成の実行ボタンが押せない（背景がブロックされている）
    let blocked = false;
    try {
      await page.getByTestId("run-introspect").click({ timeout: 1500 });
    } catch {
      blocked = true; // backdrop がクリックを奪う → intercept で失敗
    }
    check("introspect actions are blocked while the gate is open", blocked);

    // 3) PostgreSQL を選んで「設定して取得」→ Maven からDL → ゲートが消える
    await page.getByTestId("gate-check-postgresql").check();
    await page.getByTestId("gate-setup").click();
    await page.waitForSelector('[data-testid="driver-gate"]', { state: "detached", timeout: 60000 });
    check("gate closes after the selected driver is downloaded", true);

    // ロード済みドライバに PostgreSQL が出る
    await page.waitForFunction(
      () => document.body.textContent.includes("org.postgresql.Driver"),
      null,
      { timeout: 15000 },
    );
    check("downloaded driver is registered and shown", true);
    await page.close();

    // ---- confirm モード: config 宣言済みだが jar 未取得 → ダウンロード確認のみ ----
    const dir2 = mkdtempSync(join(tmpdir(), "erd-gate2-"));
    copyFileSync(INDEX, join(dir2, "index.html"));
    mkdirSync(join(dir2, "drivers"));
    mkdirSync(join(dir2, "workspace-default", "data"), { recursive: true });
    writeFileSync(
      join(dir2, "config.js"), // ドライバ設定は全ワークスペース共通（erd/config.js）
      'ERD.config({\n  drivers: {\n    artifacts: [\n      "org.postgresql:postgresql:42.7.4",\n    ],\n  },\n});\n',
      "utf-8",
    );
    const proc2 = spawn(javaBin(), ["-jar", JAR], {
      cwd: dir2,
      env: { ...process.env, ERD_NO_BROWSER: "1", ERD_PORT: "5395" },
    });
    let url2 = null;
    proc2.stdout.on("data", (d) => {
      const m = String(d).match(/ERD server: (http:\/\/[^\s]+)/);
      if (m) url2 = m[1];
    });
    proc2.stderr.on("data", () => {});
    try {
      for (let i = 0; i < 100 && url2 === null; i++) await new Promise((r) => setTimeout(r, 100));
      const page2 = await browser.newPage();
      await page2.goto(`${url2}#/w/default/introspect`);
      await page2.waitForSelector('[data-testid="driver-gate"]', { timeout: 15000 });
      const hasDownload = await page2.getByTestId("gate-download").count();
      const hasSetup = await page2.getByTestId("gate-setup").count();
      check("configured-but-missing shows the confirm gate (download only, no setup picker)",
        hasDownload === 1 && hasSetup === 0);
      await page2.getByTestId("gate-download").click();
      await page2.waitForSelector('[data-testid="driver-gate"]', { state: "detached", timeout: 60000 });
      check("confirm gate closes after download", true);
      await page2.close();
    } finally {
      proc2.kill();
    }
  } catch (e) {
    check(`no unexpected error (${e.message})`, false);
  } finally {
    await browser.close();
    proc.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
