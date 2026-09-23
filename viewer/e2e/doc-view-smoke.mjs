/**
 * テーブル画面の連続表示とドキュメントモード（R-01〜R-04）の file:// スモークテスト。
 *
 * `npm run build` 後に `npm run e2e:doc` で実行する。smoke.mjs と同じく配布物の構成を
 * 一時ディレクトリに組み立てて file:// で開き、以下を確認する:
 * - `#/tables/doc/<id>` で左パネルの範囲（ページのテーブル群）が1本の文書として出て、<id> の見出しが上端に来る
 * - 論理名・注記の解決が詳細画面と同じ（個別 / 辞書 / 未設定）
 * - (i) のホバーでポップアップ、クリックでダイアログ（型・キー・NULL）
 * - 左パネルのクリックで見出しへスクロール（詳細へ遷移しない）、スクロールで左パネルの選択が追随
 * - 「詳細 / ドキュメント」の切替で同じテーブルが開き、`#/tables` は最後のモードで開く
 * - レーン切替・フィルタで範囲が変わる。範囲 0 件の表示
 * - 静的モードでは注記のペンが出ない
 *
 * 注記の編集（R-05）はサーバーが要るため doc-notes-smoke.mjs 側で確認する。
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

const workDir = mkdtempSync(join(tmpdir(), "erd-doc-"));
copyFileSync(INDEX, join(workDir, "index.html"));
cpSync(FIXTURE, join(workDir, "workspace-default", "data"), { recursive: true });
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

  // 縦を小さめにして、3テーブルでも文書がスクロールするようにする（追随の確認のため）
  const page = await browser.newPage({ viewport: { width: 1400, height: 640 } });
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  const V = '[data-testid="panel-slot"]:not([data-hidden]) ';
  const activeRowText = async () =>
    (await page.locator(V + '[data-testid="lp-item"][data-active="true"]').first().textContent()) ?? "";
  /** セクションの見出しがスクロール枠の上端にそろっているか */
  const atTop = async (tableId) =>
    page.evaluate((id) => {
      const root = document.querySelector("[data-scroll-root]");
      const el = document.querySelector(`[data-doc-table="${id}"]`);
      if (!root || !el) return false;
      const d = el.getBoundingClientRect().top - root.getBoundingClientRect().top;
      return d >= -2 && d <= 80;
    }, tableId);

  // 1) 直リンク: users が載っている「コアドメイン」ページの3テーブルが文書になる
  await page.goto("file:///" + DIST + "#/w/default/tables/doc/public.users");
  await page.waitForSelector('[data-testid="tables-document"][data-view="doc"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="doc-section"]').length === 3);
  check("doc view renders the tables of the active page", true);
  check(
    "range heading names the page",
    ((await page.locator('[data-testid="doc-range"]').textContent()) ?? "").includes("コアドメイン"),
  );
  check(
    "sections follow the panel order (name ascending)",
    JSON.stringify(await page.locator('[data-testid="doc-section"]').evaluateAll((els) => els.map((e) => e.dataset.docTable))) ===
      JSON.stringify(["public.orders", "public.organizations", "public.users"]),
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="doc-column-row"]').length === 14);
  await page.waitForFunction(() => {
    const root = document.querySelector("[data-scroll-root]");
    const el = document.querySelector('[data-doc-table="public.users"]');
    return root && el && Math.abs(el.getBoundingClientRect().top - root.getBoundingClientRect().top) <= 80;
  });
  check("the linked table is scrolled to the top", await atTop("public.users"));
  check("left panel highlights the linked table", (await activeRowText()).includes("ユーザー"));

  // 2) 中身: 見出し・テーブル注記・カラムの論理名（個別 / 辞書 / 未設定）・注記
  const users = page.locator('[data-doc-table="public.users"]');
  check("table heading shows the logical name", ((await users.locator("h2").textContent()) ?? "").includes("ユーザー"));
  check(
    "table notes are shown in full",
    ((await users.locator('[data-testid="table-notes-text"]').textContent()) ?? "").includes("論理削除は deleted_at 運用"),
  );
  check(
    "column tags are shown in the document",
    ((await users.locator('[data-testid="doc-column-row"]', { hasText: "org_id" }).first().textContent()) ?? "").includes("pii"),
  );
  const rowOf = (name) => users.locator('[data-testid="doc-column-row"]', { hasText: name }).first();
  check("column logical name from meta", ((await rowOf("org_id").textContent()) ?? "").includes("所属組織ID"));
  check("column notes are shown in full", ((await rowOf("org_id").textContent()) ?? "").includes("NULL は個人アカウント"));
  const createdAt = (await rowOf("created_at").textContent()) ?? "";
  check("column logical name from the dictionary carries the badge", createdAt.includes("作成日時") && createdAt.includes("辞書"));
  check("unset logical name is marked", ((await rowOf("last_order_id").textContent()) ?? "").includes("未設定"));
  check("physical and logical names are both shown regardless of the display setting", createdAt.includes("created_at"));

  // 3) (i): ホバーでポップアップ（型・キー・NULL）、クリックでダイアログ
  const info = users.locator('[data-testid="doc-column-info-email"]');
  await info.hover();
  const popover = page.locator('[data-testid="doc-column-info-email-popover"]');
  await popover.waitFor();
  const popText = (await popover.textContent()) ?? "";
  check("attribute popover shows the type", popText.includes("varchar(255)"));
  check("attribute popover shows the unique key", popText.includes("ユニーク"));
  await info.click();
  const dialog = page.locator('[data-testid="doc-column-info-email-dialog"]');
  await dialog.waitFor();
  check("attribute dialog opens on click", ((await dialog.textContent()) ?? "").includes("varchar(255)"));
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.mouse.move(5, 5);
  await info.blur().catch(() => {});
  const fkInfo = users.locator('[data-testid="doc-column-info-org_id"]');
  await fkInfo.hover();
  const fkPop = page.locator('[data-testid="doc-column-info-org_id-popover"]');
  await fkPop.waitFor();
  check("attribute popover links the FK target", ((await fkPop.textContent()) ?? "").includes("組織"));
  await page.mouse.move(5, 5);
  await fkPop.waitFor({ state: "detached" });

  // 3b) 制約表: ドキュメントでは注記を出す。対応カラムは外部キー・論理外部制約だけ落とし
  //（相手テーブル名と注記の間に挟むと読みの邪魔になる）、ほかの種別は構成カラムを出す
  const cRows = (kind) => users.locator(`[data-testid="constraint-row"][data-kind="${kind}"]`);
  const cText = async (kind) => (await cRows(kind).allInnerTexts()).join("\n");
  check(
    "the constraint table shows the logical unique note inline",
    (await cText("logicalUnique")).includes("組織内でメールは重複しない"),
  );
  check(
    "foreign keys drop the column mapping in doc mode",
    !(await cText("logicalFk")).includes("→") && !(await cText("fk")).includes("→"),
  );
  check(
    "foreign keys still name the related table in doc mode",
    (await cRows("fk").locator('a[href="#/w/default/tables/public.organizations"]').count()) === 1,
  );
  // 外部キー以外は対応カラムを出す（注記が無い種別で行が空にならないように）
  check(
    "other kinds keep their columns in doc mode",
    (await cText("pk")).includes("id") &&
      (await cText("unique")).includes("email") &&
      (await cText("index")).includes("created_at") &&
      (await cText("logicalUnique")).includes("org_id") &&
      (await cText("referencedBy")).includes("→"),
  );
  check("the primary key is one row of the constraint table", (await cRows("pk").count()) === 1);
  // 項目名・種別が行の中にあるので、この2つの表には列見出し（thead）を出さない
  check(
    "the metadata and constraint tables carry no header row",
    (await users.locator('[data-testid="table-meta"] thead').count()) === 0 &&
      (await users.locator('[data-testid="constraint-table"] thead').count()) === 0,
  );
  check("the constraint table has two columns", (await cRows("fk").locator("td").count()) === 2);
  check(
    "the doc view links the pages the table is placed on",
    (await users.locator('[data-testid="page-list"] a[href^="#/w/default/erd/"]').count()) > 0,
  );

  // 4) 左パネルのクリック → 文書内の見出しへ（詳細に遷移しない）
  await page.locator(V + '[data-testid="lp-item"]', { hasText: "注文" }).first().locator("button").first().click();
  await page.waitForFunction(() => location.hash === "#/w/default/tables/doc/public.orders");
  check("panel click stays in doc mode and points the URL at the table", true);
  await page.waitForFunction(() => {
    const root = document.querySelector("[data-scroll-root]");
    const el = document.querySelector('[data-doc-table="public.orders"]');
    return root && el && Math.abs(el.getBoundingClientRect().top - root.getBoundingClientRect().top) <= 80;
  });
  check("panel click scrolls to the heading", await atTop("public.orders"));
  check("left panel highlights the clicked table", (await activeRowText()).includes("注文"));

  // 5) スクロール追随: 末尾までスクロールすると最後のテーブルが選択になる
  await page.evaluate(() => {
    const root = document.querySelector("[data-scroll-root]");
    root.scrollTo({ top: root.scrollHeight });
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="panel-slot"]:not([data-hidden]) [data-testid="lp-item"][data-active="true"]')?.textContent?.includes("ユーザー"),
  );
  check("scrolling updates the left panel selection", true);
  check("scrolling does not rewrite the URL", page.url().endsWith("#/w/default/tables/doc/public.orders"));
  // 左の一覧も選択行が見える位置へ動く（「全て」レーンで一覧を長くして確かめる）
  await page.locator(V + '[data-testid="lane-all"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="doc-section"]').length === 6);
  // 範囲が変わった直後は読んでいた位置への合わせ直し（数フレーム）が走る。それが済んでから動かす
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const root = document.querySelector("[data-scroll-root]");
    root.scrollTo({ top: 0 });
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="panel-slot"]:not([data-hidden]) [data-testid="lp-item"][data-active="true"]')?.textContent?.includes("監査ログ"),
  );
  await page.evaluate(() => {
    const root = document.querySelector("[data-scroll-root]");
    root.scrollTo({ top: root.scrollHeight });
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="panel-slot"]:not([data-hidden]) [data-testid="lp-item"][data-active="true"]')?.textContent?.includes("ユーザー"),
  );
  check(
    "the active row in the left panel is kept in view",
    await page.evaluate(() => {
      const row = document.querySelector('[data-testid="panel-slot"]:not([data-hidden]) [data-testid="lp-item"][data-active="true"]');
      // 一覧のスクロール要素（レーンの本体）は、行から見て overflow-y: auto の最も近い祖先
      let list = row.parentElement;
      while (list && getComputedStyle(list).overflowY !== "auto") list = list.parentElement;
      const r = row.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      return r.top >= l.top - 1 && r.bottom <= l.bottom + 1;
    }),
  );
  await page.locator(V + '[data-testid="lane-pages"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="doc-section"]').length === 3);

  // 6) 切替: 「詳細」は読んでいる位置のテーブルを開く。「ドキュメント」で戻れる
  await page.locator('[data-testid="view-detail"]').click();
  await page.waitForFunction(() => location.hash === "#/w/default/tables/public.users");
  check("switch to detail opens the table being read", true);
  await page.waitForSelector('[data-testid="tables-document"][data-view="detail"]');
  await page.waitForSelector('[data-doc-table="public.users"] [data-testid="table-columns"]');
  check("detail is also a continuous document of the same range", (await page.locator('[data-testid="doc-section"]').count()) === 3);
  await page.waitForFunction(() => {
    const root = document.querySelector("[data-scroll-root]");
    const el = document.querySelector('[data-doc-table="public.users"]');
    return root && el && Math.abs(el.getBoundingClientRect().top - root.getBoundingClientRect().top) <= 80;
  });
  check("detail scrolls to the table being read", await atTop("public.users"));
  // 詳細でも右のスクロールに左の選択が追随する
  await page.evaluate(() => {
    document.querySelector("[data-scroll-root]").scrollTo({ top: 0 });
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="panel-slot"]:not([data-hidden]) [data-testid="lp-item"][data-active="true"]')?.textContent?.includes("注文"),
  );
  check("scrolling the detail document updates the left panel selection", true);
  await page.locator('[data-testid="view-doc"]').click();
  await page.waitForFunction(() => location.hash.startsWith("#/w/default/tables/doc/"));
  await page.waitForSelector('[data-testid="tables-document"][data-view="doc"]');
  check("switch back to doc keeps the table being read", page.url().endsWith("#/w/default/tables/doc/public.orders"));

  // 7) モードの記憶: #/tables（ID なし）は最後に使ったモードで開く
  await page.goto("file:///" + DIST + "#/w/default/tables");
  await page.waitForFunction(() => location.hash.startsWith("#/w/default/tables/doc/"));
  check("bare #/tables opens in doc mode after using it", true);
  await page.locator('[data-testid="view-detail"]').click();
  await page.waitForFunction(() => /#\/w\/default\/tables\/public\./.test(location.hash));
  // 詳細が描かれてから（モードは着地したルートの描画で記憶される）
  await page.waitForSelector('[data-testid="tables-document"][data-view="detail"]');
  // 直前の goto と同じ URL なので、ハッシュの書き換えで開き直す（goto は同一 URL を無視する）
  await page.evaluate(() => {
    location.hash = "#/w/default/tables";
  });
  await page.waitForFunction(() => /#\/w\/default\/tables\/public\./.test(location.hash));
  check("bare #/tables opens in detail mode after switching back", true);

  // 8) レーン切替・フィルタで範囲が変わる
  await page.locator('[data-testid="view-doc"]').click();
  await page.waitForSelector('[data-testid="tables-document"][data-view="doc"]');
  await page.locator(V + '[data-testid="lane-all"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="doc-section"]').length === 6);
  check("'all' lane documents every table", true);
  check(
    "range heading says all",
    ((await page.locator('[data-testid="doc-range"]').textContent()) ?? "").includes("全て"),
  );
  const filter = page.locator(V + '[data-testid="lp-filter"]');
  await filter.click();
  await filter.pressSequentially("or");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="doc-section"]').length === 3);
  check("filter narrows the document", true);
  check(
    "range heading carries the filter word",
    ((await page.locator('[data-testid="doc-range"]').textContent()) ?? "").includes("or"),
  );
  await filter.pressSequentially("zzz");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="doc-section"]').length === 0);
  check("empty range shows a message", (await page.locator('[data-testid="tables-document"] .empty-state').count()) === 1);

  // 9) 静的モードでは注記のペンが出ない
  await page.locator(V + '[data-testid="lane-pages"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="doc-section"]').length > 0);
  check(
    "static mode shows no edit pen",
    (await page.locator('[data-testid^="doc-table-meta-edit-"], [data-testid^="doc-column-meta-edit-"]').count()) === 0,
  );

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
