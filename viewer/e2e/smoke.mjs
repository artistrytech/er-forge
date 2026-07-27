/**
 * file:// スモークテスト（Phase1 の完了条件の検証）。
 *
 * `npm run build` 後に `npm run e2e` で実行する。**配布物と同じ構成**
 * （`index.html` の隣に `data/`。設計書 §3.3 の `erd/`）を一時ディレクトリに組み立て、
 * それを file:// で開いて以下を確認する:
 * - ER図が描画される（ノード = テーブル名、エッジ = 物理FK実線 / 論理FK破線、カーディナリティ記号）
 * - ER図 ⇔ テーブルカタログをブラウザ標準のリンクで行き来できる（X-04 / B-10）
 * - ページ切替・検索（Ctrl+K）・詳細ダイアログ・未知ルート・言語切替・戻る
 *
 * データは e2e/fixtures/data（このテスト専用の小さな固定データ）を使う。
 * ビルド成果物に data/ を含めないため（配布物は index.html だけを配る）、ここで組み立てる。
 *
 * ブラウザはシステムの Edge / Chrome を使う（playwright のブラウザダウンロード不要）。
 */
import { chromium } from "playwright";
import { cpSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(here, "..", "dist", "index.html");
const FIXTURE = resolve(here, "fixtures", "data");

if (!existsSync(INDEX)) {
  console.error("dist/index.html がありません。先に npm run build を実行してください。");
  process.exit(1);
}

// 配布物と同じ構成を組み立てる（index.html の隣に workspaces.js と workspace-<id>/data/）
const workDir = mkdtempSync(join(tmpdir(), "erd-static-"));
copyFileSync(INDEX, join(workDir, "index.html"));
cpSync(FIXTURE, join(workDir, "workspace-default", "data"), { recursive: true });
// 静的モードはディレクトリを走査できないため、一覧はこのファイルだけが情報源になる
writeFileSync(
  join(workDir, "workspaces.js"),
  ['ERD.workspaces({', "  workspaces: [", '    { id: "default", name: "サンプル" },', "  ],", "});", ""].join("\n"),
);
const DIST = join(workDir, "index.html").replace(/\\/g, "/");

const results = [];
const errors = [];

function check(name, cond) {
  const line = `${cond ? "PASS" : "FAIL"}: ${name}`;
  results.push(line);
  // 逐次出力もする（どこで止まったかが分かるように。まとめは最後にもう一度出す）
  if (process.env.ERD_E2E_VERBOSE) console.log(line);
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
  await page.waitForSelector('[data-testid="erd-node"]', { timeout: 10000 });
  check("hash redirects to first diagram", page.url().includes("#/w/default/erd/core"));
  check("core page renders 3 nodes", (await page.locator('[data-testid="erd-node"]').count()) === 3);
  check("edges render", (await page.locator('[data-testid="erd-edge"]').count()) === 4);
  check("logical edge is dashed class", (await page.locator('[data-testid="erd-edge"][data-kind="logical"]').count()) === 1);
  check("cardinality markers render", (await page.locator('[data-testid="card-marker"]').count()) >= 8);
  check("legend visible", await page.locator('[data-testid="erd-legend"]').isVisible());
  // 指定色（P-13）は静的モードでも効く（index.js に載っているため）
  check(
    "the specified color reaches the node in static mode",
    (await page.locator('[data-testid="erd-node"][data-color="blue"]').count()) === 1,
  );
  check(
    "the table list row uses the same color",
    (await page.locator('[data-testid="lp-item"][data-color="blue"]').count()) >= 1,
  );
  check("mode badge shows static", await page.locator('[data-testid="mode-badge"][data-mode="static"]').isVisible());
  // 閲覧中は「編集開始」（ペン）が出る。バッジ表示は廃止
  check("start-edit shown when viewing", await page.locator('[data-testid="session-toggle"][data-editing="false"]').isVisible());
  check("minimap renders nodes", (await page.locator(".react-flow__minimap-node").count()) === 3);
  // ER図上でノードを選ぶと、左パネルの一覧の選択も追随する（一覧 → キャンバスの逆方向）
  await page.click('[data-testid="erd-node"] >> nth=0');
  check(
    "selecting a node on the canvas selects the row in the left panel",
    (await page.locator('[data-testid="lp-item"][data-active="true"]').count()) === 1,
  );

  // 2) ページ切替（B-01）: 左パネル「ページ」レーンの行で billing へ
  //（レーン刷新でページ行は <a> ではなくボタンになっている）
  await page.click('[data-testid="page-row"] >> text=課金');
  await page.waitForFunction(() => location.hash === "#/w/default/erd/billing");
  await page.waitForSelector('[data-testid="erd-node"]');
  check("billing page renders 3 nodes", (await page.locator('[data-testid="erd-node"]').count()) === 3);

  // 3) ノードのダブルクリック → 閲覧専用ダイアログ（D-06 / G-01）
  await page.dblclick('[data-testid="erd-node"] >> nth=0');
  await page.waitForSelector(".dialog");
  check("table dialog opens on dblclick", await page.locator(".dialog").isVisible());
  await page.waitForSelector(".dialog .data-table tbody tr");
  check("dialog shows columns", (await page.locator(".dialog .data-table tbody tr").count()) > 0);
  check(
    "dialog has real link to table detail (G-06)",
    (await page.locator('.dialog a[href^="#/w/default/tables/"]').count()) > 0,
  );

  // 4) ダイアログのリンク → テーブル詳細画面（B-10）
  await page.click(".dialog .button-link");
  await page.waitForSelector(".catalog-page");
  check("navigates to table detail", page.url().includes("#/w/default/tables/public."));
  check("detail shows column table", (await page.locator(".data-table tbody tr").count()) > 0);

  // 5) 詳細画面 → ER図ページへのリンク（O-04）
  const backToErd = page.locator('[data-testid="page-list"] a[href^="#/w/default/erd/"]');
  check("detail links back to diagram pages", (await backToErd.count()) > 0);
  await backToErd.first().click();
  await page.waitForSelector('[data-testid="erd-node"]');
  check("navigates back to diagram with focus", page.url().includes("#/w/default/erd/"));

  // 5b) 制約は種類ごとの見出しで平坦に並び、1件 = 1枠。外部キーは被参照と同じ形
  //（相手テーブル + カラム対応）で見せ、制約名などは虫眼鏡のリレーション詳細に寄せる
  await page.goto("file:///" + DIST + "#/w/default/tables/public.users");
  await page.waitForSelector('[data-testid="fk-list"]');
  check(
    "foreign keys show the referenced table with the column mapping",
    (await page.locator('[data-testid="fk-list"] a[href="#/w/default/tables/public.organizations"]').count()) === 1 &&
      (await page.locator('[data-testid="fk-list"]').textContent()).includes("org_id → id"),
  );
  check(
    "the physical constraint name is not shown in the list",
    !(await page.locator('[data-testid="fk-list"]').textContent()).includes("users_org_id_fkey"),
  );
  // 一意制約・インデックスも同じ形（構成カラム + 虫眼鏡）。制約名は詳細ダイアログに寄せる
  check(
    "uniques and indexes show their columns without the constraint name",
    (await page.locator('[data-testid="unique-list"]').textContent()).trim() === "email" &&
      !(await page.locator('[data-testid="index-list"]').textContent()).includes("idx_users_created_at"),
  );
  await page.locator('[data-testid="lunique-list"] [data-testid="constraint-detail"]').click();
  await page.waitForSelector(".dialog");
  const luniqueText = await page.locator(".dialog").textContent();
  check(
    "constraint detail dialog shows the name, columns and notes",
    luniqueText.includes("luk_users_org_email") &&
      luniqueText.includes("org_id") &&
      luniqueText.includes("email") &&
      luniqueText.includes("組織内でメールは重複しない"),
  );
  await page.keyboard.press("Escape");

  const relDetail = page.locator('[data-testid="relation-detail"]');
  // 参照（物理FK・論理外部制約）と被参照の3件すべてに詳細ボタンが出る
  check("relation detail is offered for references and back-references", (await relDetail.count()) === 3);
  await relDetail.first().click();
  await page.waitForSelector(".dialog");
  check(
    "relation detail dialog opens from the table detail",
    (await page.locator(".dialog").textContent()).includes("users_org_id_fkey"),
  );
  await page.keyboard.press("Escape");

  // 6) テーブル画面（O-01。一覧と詳細を統合。左パネル「全て」レーンで一覧＋絞り込み）
  await page.click('a[href="#/w/default/tables"]');
  // 素の #/tables は先頭テーブルへ振り替わる（回答E: 未選択状態は作らない）
  await page.waitForFunction(() => location.hash.startsWith("#/w/default/tables/"));
  const V = '[data-testid="panel-slot"]:not([data-hidden]) '; // 両パネル常時マウントのため表示中に限定
  await page.click(V + '[data-testid="lane-all"]');
  await page.waitForSelector(V + '[data-testid="lp-item"]');
  check("all-tables lane lists 6 tables", (await page.locator(V + '[data-testid="lp-item"]').count()) === 6);
  await page.locator(V + '[data-testid="lp-filter"]').pressSequentially("注文");
  check(
    "all-tables filter works (注文 → 2)",
    (await page.locator(V + '[data-testid="lp-item"]').count()) === 2,
  );
  await page.locator(V + '[data-testid="lp-filter"]').fill("");

  // 7) 検索（F-01 / F-05）: Ctrl+K で開き、カラム論理名でヒット
  await page.keyboard.press("Control+k");
  await page.waitForSelector('[data-testid="search-input"]');
  await page.fill('[data-testid="search-input"]', "メールアドレス");
  await page.waitForSelector('[data-testid="search-result"]');
  check("search hits by column logical name", (await page.locator('[data-testid="search-result"]').count()) >= 1);
  await page.keyboard.press("Escape");

  // 8) エッジのダブルクリック → リレーション詳細（E-10）
  // 水平なエッジは bounding box の高さが 0 で「不可視」扱いになるため座標指定でクリック
  await page.goto("file:///" + DIST + "#/w/default/erd/core");
  await page.waitForSelector('[data-testid="erd-edge"] path', { state: "attached" });
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
  await page.goto("file:///" + DIST + "#/w/default/nope");
  await page.waitForSelector(".empty-state");
  check(
    "unknown route shows not-found with link to #/tables",
    (await page.locator('.empty-state a[href="#/w/default/tables"]').count()) === 1,
  );

  // 10) 編集ルートは閲覧表示 + 通知（§4.4）
  await page.goto("file:///" + DIST + "#/w/default/tables/public.users/edit");
  await page.waitForSelector(".notice-banner");
  check("edit route shows read-only notice", await page.locator(".notice-banner").isVisible());

  // 11) 言語切替（L-04）: 設定（歯車）メニューを開いてから言語セレクトを操作する
  // （タイトルはワークスペース名なので言語では変わらない。ナビの文言で判定する）
  await page.click('[data-testid="settings-button"]');
  await page.waitForSelector('[data-testid="settings-menu"]');
  await page.selectOption('[data-testid="header-select"] >> nth=1', "en");
  check(
    "language switch to English",
    (await page.locator('[data-testid="app-title"]').textContent()) === "サンプル" &&
      (await page.locator('a[href="#/w/default/tables"]').first().textContent()) === "Tables",
  );

  // 11b) タイトル = ワークスペース名。プルダウンに一覧が出る（静的モードは切替のみ）
  await page.click('[data-testid="workspace-menu-button"]');
  await page.waitForSelector('[data-testid="workspace-menu"]');
  check(
    "workspace menu lists the workspace",
    (await page.locator('[data-testid="workspace-item"]').count()) === 1,
  );
  check(
    "static mode cannot add workspaces",
    (await page.locator('[data-testid="workspace-add"]').count()) === 0,
  );
  await page.keyboard.press("Escape");

  // 12) ブラウザの戻る（X-05）
  await page.goBack();
  check("browser back works (hash history)", page.url().includes("#/w/default/nope"));

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

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
