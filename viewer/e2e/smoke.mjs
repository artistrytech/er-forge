/**
 * file:// スモークテスト（Phase1 の完了条件の検証）。
 *
 * `npm run build` 後に `npm run e2e` で実行する。dist/index.html をブラウザの
 * file:// で開き、以下を確認する:
 * - ER図が描画される（ノード = テーブル名、エッジ = 物理FK実線 / 論理FK破線、カーディナリティ記号）
 * - ER図 ⇔ テーブルカタログをブラウザ標準のリンクで行き来できる（X-04 / B-10）
 * - ページ切替・検索（Ctrl+K）・詳細ダイアログ・未知ルート・言語切替・戻る
 *
 * ブラウザはシステムの Edge / Chrome を使う（playwright のブラウザダウンロード不要）。
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(here, "..", "dist", "index.html").replace(/\\/g, "/");

const results = [];
const errors = [];

function check(name, cond) {
  results.push(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
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
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  // 1) 起動 → ホーム → 最初のER図ページへリダイレクト
  await page.goto("file:///" + DIST);
  await page.waitForSelector(".erd-node", { timeout: 10000 });
  check("hash redirects to first diagram", page.url().includes("#/erd/core"));
  check("core page renders 3 nodes", (await page.locator(".erd-node").count()) === 3);
  check("edges render", (await page.locator(".erd-edge").count()) === 4);
  check("logical edge is dashed class", (await page.locator(".erd-edge-logical").count()) === 1);
  check("cardinality markers render", (await page.locator(".erd-card-marker").count()) >= 8);
  check("legend visible", await page.locator(".erd-legend").isVisible());
  check("mode badge shows static", await page.locator(".mode-badge.mode-static").isVisible());
  check("session badge shows viewing", await page.locator(".session-badge").isVisible());
  check("minimap renders nodes", (await page.locator(".react-flow__minimap-node").count()) === 3);

  // 2) ページ切替（B-01）: サイドバーのリンクで billing へ
  await page.click('a[href="#/erd/billing"]');
  await page.waitForFunction(() => location.hash === "#/erd/billing");
  await page.waitForSelector(".erd-node");
  check("billing page renders 3 nodes", (await page.locator(".erd-node").count()) === 3);

  // 3) ノードのダブルクリック → 閲覧専用ダイアログ（D-06 / G-01）
  await page.dblclick(".erd-node >> nth=0");
  await page.waitForSelector(".dialog");
  check("table dialog opens on dblclick", await page.locator(".dialog").isVisible());
  await page.waitForSelector(".dialog .data-table tbody tr");
  check("dialog shows columns", (await page.locator(".dialog .data-table tbody tr").count()) > 0);
  check(
    "dialog has real link to table detail (G-06)",
    (await page.locator('.dialog a[href^="#/tables/"]').count()) > 0,
  );

  // 4) ダイアログのリンク → テーブル詳細画面（B-10）
  await page.click(".dialog .button-link");
  await page.waitForSelector(".catalog-page");
  check("navigates to table detail", page.url().includes("#/tables/public."));
  check("detail shows column table", (await page.locator(".data-table tbody tr").count()) > 0);

  // 5) 詳細画面 → ER図ページへのリンク（O-04）
  const backToErd = page.locator('.page-list a[href^="#/erd/"]');
  check("detail links back to diagram pages", (await backToErd.count()) > 0);
  await backToErd.first().click();
  await page.waitForSelector(".erd-node");
  check("navigates back to diagram with focus", page.url().includes("#/erd/"));

  // 6) テーブル一覧（O-01）
  await page.click('a[href="#/tables"]');
  await page.waitForSelector(".catalog-table tbody tr");
  check("catalog lists 6 tables", (await page.locator(".catalog-table tbody tr").count()) === 6);
  await page.fill(".catalog-filter", "注文");
  check("catalog filter works (注文 → 2)", (await page.locator(".catalog-table tbody tr").count()) === 2);
  await page.fill(".catalog-filter", "");

  // 7) 検索（F-01 / F-05）: Ctrl+K で開き、カラム論理名でヒット
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".search-input");
  await page.fill(".search-input", "メールアドレス");
  await page.waitForSelector(".search-result");
  check("search hits by column logical name", (await page.locator(".search-result").count()) >= 1);
  await page.keyboard.press("Escape");

  // 8) エッジのダブルクリック → リレーション詳細（E-10）
  // 水平なエッジは bounding box の高さが 0 で「不可視」扱いになるため座標指定でクリック
  await page.goto("file:///" + DIST + "#/erd/core");
  await page.waitForSelector(".erd-edge-path", { state: "attached" });
  await page.waitForTimeout(500);
  const mid = await page.evaluate(() => {
    const p = document.querySelector(".react-flow__edge-interaction");
    const r = p.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.max(r.height / 2, 0) };
  });
  await page.mouse.dblclick(mid.x, mid.y);
  const relDialogOpen = await page
    .waitForSelector(".dialog", { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check("relation dialog opens on edge dblclick", relDialogOpen);
  await page.keyboard.press("Escape");

  // 9) 未知ルート（B-11）
  await page.goto("file:///" + DIST + "#/nope");
  await page.waitForSelector(".empty-state");
  check(
    "unknown route shows not-found with link to #/tables",
    (await page.locator('.empty-state a[href="#/tables"]').count()) === 1,
  );

  // 10) 編集ルートは閲覧表示 + 通知（§4.4）
  await page.goto("file:///" + DIST + "#/tables/public.users/edit");
  await page.waitForSelector(".notice-banner");
  check("edit route shows read-only notice", await page.locator(".notice-banner").isVisible());

  // 11) 言語切替（L-04）
  await page.selectOption(".header-select >> nth=1", "en");
  check(
    "language switch to English",
    (await page.locator(".app-title").textContent()) === "ER Diagram Tool",
  );

  // 12) ブラウザの戻る（X-05）
  await page.goBack();
  check("browser back works (hash history)", page.url().includes("#/nope"));

  await browser.close();

  console.log(results.join("\n"));
  if (errors.length > 0) {
    console.log("\n--- console/page errors ---");
    console.log(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("\nno console errors");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
