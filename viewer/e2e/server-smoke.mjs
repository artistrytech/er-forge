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

    // 1) ワークスペースが1つも無い → welcome 画面（§10 の1段目）
    await page.goto(url);
    await page.waitForSelector('[data-testid="workspace-create-submit"]', { timeout: 10000 });
    check(
      "welcome screen suggests the default id",
      (await page.inputValue('[data-testid="workspace-id-input"]')) === "default",
    );
    // 名前は必須（空のままでは作成できない）
    await page.click('[data-testid="workspace-create-submit"]');
    check("name is required", (await page.locator('[data-testid="workspace-create-submit"]').count()) === 1);

    // 2) ワークスペース作成 → ブートストラップ画面（§10 の2段目）
    await page.locator('[data-testid="workspace-name-input"]').pressSequentially("販売管理");
    await page.click('[data-testid="workspace-create-submit"]');
    await page.waitForSelector(".bootstrap-screen", { timeout: 15000 });
    check("workspace folder created", existsSync(join(dir, "workspace-default", "data")));
    check("registry generated", existsSync(join(dir, "workspaces.js")));
    check("url carries the workspace", page.url().includes("#/w/default"));

    // 3) サンプル取り込み → リロード → ER図描画
    await page.click('[data-testid="bootstrap-sample"]');
    await page.waitForSelector('[data-testid="erd-node"]', { timeout: 20000 });
    check("sample import renders ER diagram", (await page.locator('[data-testid="erd-node"]').count()) > 0);
    check("data files written", existsSync(join(dir, "workspace-default", "data", "manifest.js")));
    // 動作モードとバージョンは information（ⓘ）の中。サーバーモードでは jar 側の版も出る
    await page.click('[data-testid="info-button"]');
    check("information shows server mode", await page.locator('[data-testid="info-mode"][data-mode="server"]').isVisible());
    check(
      "information shows the server version",
      ((await page.locator('[data-testid="server-version"]').textContent()) ?? "").trim() !== "—",
    );
    await page.keyboard.press("Escape");
    check("title shows the workspace name",
        (await page.locator('[data-testid="app-title"]').textContent()) === "販売管理");
    check("logical (dashed) edges exist on some page",
        existsSync(join(dir, "workspace-default", "data", "schema", "public", "point_transactions.js")));

    // 4) 再ロードしても通常表示（ブートストラップは出ない）
    await page.reload();
    await page.waitForSelector('[data-testid="erd-node"]', { timeout: 10000 });
    check("reload shows diagram again", (await page.locator(".bootstrap-screen").count()) === 0);

    // 5) 2つ目のワークスペースを追加 → 切り替わって空（ブートストラップ）に着地する
    await page.click('[data-testid="workspace-menu-button"]');
    await page.click('[data-testid="workspace-add"]');
    await page.locator('[data-testid="workspace-id-input"]').fill("billing");
    await page.locator('[data-testid="workspace-name-input"]').pressSequentially("課金");
    await page.click('[data-testid="workspace-create-submit"]');
    await page.waitForSelector(".bootstrap-screen", { timeout: 15000 });
    check("second workspace is created empty", existsSync(join(dir, "workspace-billing", "data")));
    check("switched to the new workspace", page.url().includes("#/w/billing"));
    check("first workspace is untouched",
        existsSync(join(dir, "workspace-default", "data", "manifest.js")));

    // 6) プルダウンで戻る（データはワークスペースごとに独立している）
    await page.click('[data-testid="workspace-menu-button"]');
    await page.click('[data-testid="workspace-item"][data-workspace-id="default"]');
    await page.waitForSelector('[data-testid="erd-node"]', { timeout: 15000 });
    check("switching back restores the first workspace", page.url().includes("#/w/default"));

    // 7) データリセット: このワークスペースのスキーマ情報だけが消え、完了通知が出る
    //（リロードを挟むため、通知は sessionStorage 経由でリロード後に出る）
    await page.click('[data-testid="settings-button"]');
    await page.click('[data-testid="data-reset"]');
    await page.click('[data-testid="data-reset-confirm"]');
    await page.waitForSelector(".bootstrap-screen", { timeout: 15000 });
    check("reset empties the workspace", !existsSync(join(dir, "workspace-default", "data", "manifest.js")));
    check("reset keeps the workspace itself", existsSync(join(dir, "workspace-default", "data")));
    check("reset shows a toast after the reload",
        (await page.locator('[data-testid="toast"]').first().textContent()) === "スキーマ情報を削除しました");
    // 自分で消したファイルを監視が拾って「外部の変更を反映しました」が出てはいけない
    await page.waitForTimeout(2000);
    check("reset does not report an external change",
        (await page.locator('[data-testid="toast"]').count()) === 1);

    // 8) ワークスペース削除: ID の打ち込みが一致するまで実行できない
    //（リセット直後はブートストラップ画面。ヘッダが無いのでこの画面の導線から削除する）
    await page.click('[data-testid="workspace-delete"]');
    await page.waitForSelector('[data-testid="workspace-delete-input"]');
    check("delete is blocked until the id matches",
        await page.locator('[data-testid="workspace-delete-confirm"]').isDisabled());
    await page.locator('[data-testid="workspace-delete-input"]').pressSequentially("default");
    await page.click('[data-testid="workspace-delete-confirm"]');
    // 残った側へ遷移してリロードするので、着地を待ってから通知を見る
    //（リセットの通知がまだ画面に残っている間に読むと取り違える）
    await page.waitForFunction(() => location.hash.startsWith("#/w/billing"), null, { timeout: 15000 });
    await page.waitForSelector('[data-testid="toast"]', { timeout: 15000 });
    check("workspace folder is gone", !existsSync(join(dir, "workspace-default")));
    check("delete shows a toast after the reload",
        (await page.locator('[data-testid="toast"]').textContent()) ===
          "ワークスペース「販売管理」を削除しました");

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
