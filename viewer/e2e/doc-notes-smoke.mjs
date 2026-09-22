/**
 * テーブル画面・ER図からの論理情報の直接編集（R-05）のスモークテスト（サーバーモード）。
 *
 * - サンプルデータを取り込み、ドキュメント（`#/tables/doc/<id>`）を開く
 * - 注記の行のペンからテーブル注記を書く → 確定で即時保存され、schema/**.js に `notes` が書かれる
 * - 行末のペンからカラム注記を書く → `meta.columns[].notes` が書かれ、画面にも反映される
 * - 外部でファイルを書き換えた後に保存しても、その変更を踏み潰さない（読み直してから書く）
 * - 注記を空にして確定すると `notes` キーが消える
 * - 同じダイアログで論理名・タグ・色も書ける（テーブル / カラム）
 * - ER図のテーブル詳細ダイアログでも同じペンが出る。制約の詳細・論理情報のダイアログは
 *   その上に重なり、閉じるとテーブル詳細へ戻る
 * - 論理制約（論理外部制約・論理一意制約）は詳細ダイアログから削除でき、ファイルからも消える
 *
 * 前提: `npm run build` と `gradlew shadowJar` 済み。実行: `node e2e/doc-notes-smoke.mjs`
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** 制御コンポーネントへの入力は実際のキー入力で行う（fill() は React の onChange を起こさない） */
async function typeInto(locator, text) {
  await locator.click();
  await locator.press("ControlOrMeta+a");
  if (text === "") await locator.press("Backspace");
  else await locator.pressSequentially(text);
}

/** ファイルに文字列が書かれるまで待つ（保存は非同期。最大 15 秒） */
async function waitForFile(file, text) {
  for (let i = 0; i < 150; i++) {
    if (readFileSync(file, "utf-8").includes(text)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
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
  const dir = mkdtempSync(join(tmpdir(), "erd-docnotes-"));
  copyFileSync(INDEX, join(dir, "index.html"));
  mkdirSync(join(dir, "workspace-default", "data"), { recursive: true });
  const usersFile = join(dir, "workspace-default", "data", "schema", "public", "users.js");

  const proc = spawn(javaBin(), ["-jar", JAR], {
    cwd: dir,
    env: { ...process.env, ERD_NO_BROWSER: "1", ERD_PORT: "5393" },
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

    const token = new URL(url).searchParams.get("t");
    const origin = new URL(url).origin;
    const boot = await fetch(`${origin}/__erd/w/default/bootstrap?t=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "sample" }),
    });
    check("sample bootstrap succeeds", boot.status === 200);

    const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`${url}#/w/default/tables/doc/public.users`);
    await page.waitForSelector('[data-doc-table="public.users"] [data-testid="doc-column-row"]', { timeout: 15000 });
    const users = page.locator('[data-doc-table="public.users"]');
    check("server mode shows the notes pens", (await users.locator('[data-testid="doc-table-meta-edit-public.users"]').count()) === 1);

    // ---- テーブル注記 ----
    await users.locator('[data-testid="doc-table-meta-edit-public.users"]').click();
    await page.waitForSelector('[data-testid="notes-input"]', { timeout: 5000 });
    await typeInto(page.locator('[data-testid="notes-input"]'), "ドキュメントから書いたテーブル注記");
    await page.locator('[data-testid="notes-apply"]').click();
    await page.waitForSelector('[data-testid="notes-input"]', { state: "detached", timeout: 15000 });
    await page.waitForFunction(
      () => document.querySelector('[data-doc-table="public.users"] [data-testid="table-notes-text"]')?.textContent?.includes("ドキュメントから書いたテーブル注記"),
      null,
      { timeout: 15000 },
    );
    check("table notes show up in the document after saving", true);
    check("table notes are written to the schema file", readFileSync(usersFile, "utf-8").includes('notes: "ドキュメントから書いたテーブル注記"'));
    check("saving keeps the URL in doc mode", page.url().includes("#/w/default/tables/doc/public.users"));

    // ---- 外部変更を踏み潰さない（読み直してから書く） ----
    const before = readFileSync(usersFile, "utf-8");
    writeFileSync(usersFile, before.replace('displayName: "ユーザー情報"', 'displayName: "外部で変えた論理名"'));
    // 外部変更バナーが出る（H-09）。編集は続けられる
    await new Promise((r) => setTimeout(r, 1500));

    // ---- カラム注記 ----
    const emailRow = users.locator('[data-testid="doc-column-row"]', { hasText: "email" }).first();
    await emailRow.locator('[data-testid="doc-column-meta-edit-email"]').click();
    await page.waitForSelector('[data-testid="notes-input"]', { timeout: 5000 });
    await typeInto(page.locator('[data-testid="notes-input"]'), "ログイン ID を兼ねる");
    await page.locator('[data-testid="notes-apply"]').click();
    await page.waitForSelector('[data-testid="notes-input"]', { state: "detached", timeout: 15000 });
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-doc-table="public.users"] [data-testid="doc-column-notes"]')].some((e) => e.textContent?.includes("ログイン ID を兼ねる")),
      null,
      { timeout: 15000 },
    );
    check("column notes show up in the document after saving", true);
    const afterColumn = readFileSync(usersFile, "utf-8");
    check("column notes are written under meta.columns", /email: \{[^}]*notes: "ログイン ID を兼ねる"/.test(afterColumn));
    check("the external change made before saving survives (read-modify-write)", afterColumn.includes('displayName: "外部で変えた論理名"'));
    check("the table notes written earlier survive too", afterColumn.includes('notes: "ドキュメントから書いたテーブル注記"'));

    // ---- 空にして確定 → notes キーが消える ----
    await users.locator('[data-testid="doc-table-meta-edit-public.users"]').click();
    await page.waitForSelector('[data-testid="notes-input"]', { timeout: 5000 });
    await typeInto(page.locator('[data-testid="notes-input"]'), "");
    await page.locator('[data-testid="notes-apply"]').click();
    await page.waitForSelector('[data-testid="notes-input"]', { state: "detached", timeout: 15000 });
    await page.waitForFunction(
      () => document.querySelector('[data-doc-table="public.users"] [data-testid="table-notes-text"]') === null,
      null,
      { timeout: 15000 },
    );
    const afterClear = readFileSync(usersFile, "utf-8");
    check("clearing the notes removes the key from the file", !afterClear.includes("ドキュメントから書いたテーブル注記"));
    check("clearing the table notes leaves the column notes alone", afterClear.includes('notes: "ログイン ID を兼ねる"'));

    // ---- 見出しの編集ペンはドキュメントでも出て、そのテーブルを編集する。終了後は最後のモードへ戻る ----
    const startEdit = page.locator('[data-testid="doc-table-edit-public.users"]');
    check("the edit pen is shown in doc mode", (await startEdit.count()) === 1);
    // 保存直後の再描画が落ち着くのを待つ
    await page.waitForFunction(
      () => document.querySelector('[data-testid="doc-table-edit-public.users"]')?.getAttribute("href") === "#/w/default/tables/public.users/edit",
      null,
      { timeout: 15000 },
    );
    check("the edit pen targets the table it sits on", true);
    await startEdit.click();
    await page.waitForFunction(() => location.hash === "#/w/default/tables/public.users/edit", null, { timeout: 15000 });
    await page.waitForSelector('[data-testid="session-toggle"][data-editing="true"]', { timeout: 15000 });
    await page.locator('[data-testid="session-toggle"][data-editing="true"]').click();
    await page.waitForFunction(() => location.hash === "#/w/default/tables/doc/public.users", null, { timeout: 15000 });
    check("ending the edit returns to the document (the last view mode)", true);

    // ---- 詳細でも注記を編集できる（テーブル・カラム・物理FK の多重度の補足・論理外部制約） ----
    const itemsFile = join(dir, "workspace-default", "data", "schema", "public", "order_items.js");
    await page.goto(`${url}#/w/default/tables/public.order_items`);
    await page.waitForSelector('[data-doc-table="public.order_items"] [data-testid="fk-list"]', { timeout: 15000 });
    const items = page.locator('[data-doc-table="public.order_items"]');
    const applyNotes = async (text) => {
      await page.waitForSelector('[data-testid="notes-input"]', { timeout: 5000 });
      await typeInto(page.locator('[data-testid="notes-input"]'), text);
      await page.locator('[data-testid="notes-apply"]').click();
      await page.waitForSelector('[data-testid="notes-input"]', { state: "detached", timeout: 15000 });
    };
    // カラム注記（詳細の注記セルのペン）
    await items.locator('[data-testid="column-meta-edit-quantity"]').click();
    await applyNotes("1 以上");
    await items.locator('[data-testid="column-notes-quantity"]').waitFor({ timeout: 15000 });
    check("detail: column notes can be edited and show up as the note icon", true);
    // 物理FK の多重度の補足（meta.relations）: リレーション詳細の中でその場編集
    const inlineEdit = async (testId, text) => {
      await page.locator(`[data-testid="${testId}-edit"]`).click();
      await page.waitForSelector(`[data-testid="${testId}-input"]`, { timeout: 5000 });
      await typeInto(page.locator(`[data-testid="${testId}-input"]`), text);
      await page.locator(`[data-testid="${testId}-apply"]`).click();
      await page.waitForSelector(`[data-testid="${testId}-editor"]`, { state: "detached", timeout: 15000 });
    };
    await items.locator('[data-testid="fk-list"] [data-testid="relation-detail"]').first().click();
    await page.waitForSelector('[data-testid="relation-cardinality-notes"]', { timeout: 5000 });
    check(
      "detail: the relation dialog shows the cardinality note with a pen",
      (await page.locator('[data-testid="relation-cardinality-notes"]').textContent()) === "注文には必ず1明細以上が存在する" &&
        (await page.locator('[data-testid="relation-cardinality-notes-edit"]').count()) === 1,
    );
    await inlineEdit("relation-cardinality-notes", "注文には必ず1明細以上が存在する（変更）");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="relation-cardinality-notes"]')?.textContent === "注文には必ず1明細以上が存在する（変更）",
      null,
      { timeout: 15000 },
    );
    check("detail: the cardinality note is updated in the open dialog", true);
    await waitForFile(itemsFile, "注文には必ず1明細以上が存在する（変更）");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".dialog", { state: "detached", timeout: 5000 });
    // 論理外部制約の注記: 同じくリレーション詳細の中で
    await items.locator('[data-testid="lfk-list"] [data-testid="relation-detail"]').first().click();
    await page.waitForSelector('[data-testid="relation-notes"]', { timeout: 5000 });
    await inlineEdit("relation-notes", "在庫への論理参照（変更）");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="relation-notes"]')?.textContent === "在庫への論理参照（変更）",
      null,
      { timeout: 15000 },
    );
    // 論理外部制約の多重度の補足（空 → 書く）
    await inlineEdit("relation-cardinality-notes", "在庫は後追いで作られる");
    await waitForFile(itemsFile, "在庫は後追いで作られる");
    check("detail: a logical FK gets its cardinality note from the dialog", readFileSync(itemsFile, "utf-8").includes('"lfk:lfk_order_items_inventories": { notes: "在庫は後追いで作られる" }'));
    await page.keyboard.press("Escape");
    await page.waitForSelector(".dialog", { state: "detached", timeout: 5000 });
    await waitForFile(itemsFile, "在庫への論理参照（変更）");
    const itemsAfter = readFileSync(itemsFile, "utf-8");
    check("detail: column notes are written under meta.columns", /quantity: \{[^}]*notes: "1 以上"/.test(itemsAfter));
    check(
      "detail: the physical FK note is written to meta.relations",
      itemsAfter.includes('"fk:order_items_order_id_fkey": { child: "1..N", notes: "注文には必ず1明細以上が存在する（変更）" }'),
    );
    check("detail: the logical FK note is written", itemsAfter.includes('notes: "在庫への論理参照（変更）"'));
    check("detail: the logical FK definition is otherwise unchanged", itemsAfter.includes('ref: { table: "public.inventories", columns: ["product_id"] }'));
    // テーブル注記（詳細の注記行のペン）
    await items.locator('[data-testid="table-meta-edit-public.order_items"]').click();
    await applyNotes("詳細から書いたテーブル注記");
    await page.waitForFunction(
      () => document.querySelector('[data-doc-table="public.order_items"] [data-testid="table-notes-text"]')?.textContent?.includes("詳細から書いたテーブル注記"),
      null,
      { timeout: 15000 },
    );
    check("detail: table notes can be edited", readFileSync(itemsFile, "utf-8").includes('notes: "詳細から書いたテーブル注記"'));
    check("detail: editing keeps the URL in detail mode", page.url().includes("#/w/default/tables/public.order_items"));

    // ---- 詳細: 論理外部制約をリレーション詳細から削除する（確認をはさんで即時保存） ----
    await items.locator('[data-testid="lfk-list"] [data-testid="relation-detail"]').first().click();
    await page.waitForSelector('[data-testid="relation-delete"]', { timeout: 5000 });
    await page.locator('[data-testid="relation-delete"]').click();
    await page.waitForSelector('[data-testid="constraint-delete-confirm"]', { timeout: 5000 });
    await page.locator('[data-testid="constraint-delete-confirm"]').click();
    await page.waitForSelector(".dialog", { state: "detached", timeout: 15000 });
    await page.waitForFunction(
      () => document.querySelector('[data-doc-table="public.order_items"] [data-testid="lfk-list"]') === null,
      null,
      { timeout: 15000 },
    );
    const itemsDeleted = readFileSync(itemsFile, "utf-8");
    check("detail: a logical FK can be deleted from the relation dialog", !itemsDeleted.includes("lfk_order_items_inventories"));
    check("detail: deleting the logical FK drops its cardinality entry too", !itemsDeleted.includes("在庫は後追いで作られる"));
    check("detail: the physical FK settings survive the deletion", itemsDeleted.includes('"fk:order_items_order_id_fkey"'));

    // ---- 論理名・タグ・色も同じダイアログで（ドキュメント。テーブル） ----
    await page.goto(`${url}#/w/default/tables/doc/public.users`);
    await page.waitForSelector('[data-doc-table="public.users"] [data-testid="doc-column-row"]', { timeout: 15000 });
    await users.locator('[data-testid="doc-table-meta-edit-public.users"]').click();
    await page.waitForSelector('[data-testid="meta-display-name"]', { timeout: 5000 });
    check(
      "the table dialog opens with the current logical name",
      (await page.locator('[data-testid="meta-display-name"]').inputValue()) === "外部で変えた論理名",
    );
    await typeInto(page.locator('[data-testid="meta-display-name"]'), "ユーザー");
    await page.locator('[data-testid="meta-tags"]').click();
    await page.locator('[data-testid="meta-tags"]').pressSequentially("core");
    await page.locator('[data-testid="meta-tags"]').press("Enter");
    // 候補が開いたままだと下の欄に重なる。Esc は候補を閉じるだけでダイアログは閉じない
    await page.locator('[data-testid="meta-tags"]').press("Escape");
    await page.waitForSelector('[data-testid="tag-suggestion"]', { state: "detached", timeout: 5000 });
    check("Esc in the tag input keeps the dialog open", (await page.locator('[data-testid="meta-display-name"]').count()) === 1);
    await page.locator('[data-testid="meta-color-trigger"]').click();
    await page.locator('[data-testid="color-green"]').click();
    await page.locator('[data-testid="notes-apply"]').click();
    await page.waitForSelector('[data-testid="meta-display-name"]', { state: "detached", timeout: 15000 });
    await waitForFile(usersFile, 'color: "green"');
    const usersMeta = readFileSync(usersFile, "utf-8");
    check("table logical name is written", usersMeta.includes('displayName: "ユーザー"'));
    check("table tags are written (existing + added)", usersMeta.includes('tags: ["auth", "core"]'));
    check("table color is written", usersMeta.includes('color: "green"'));
    await page.waitForFunction(
      () => document.querySelector('[data-doc-table="public.users"] h2')?.textContent?.includes("ユーザー (users)"),
      null,
      { timeout: 15000 },
    );
    check("the heading follows the new logical name", true);

    // ---- カラムの論理名（辞書の値を上書き） ----
    await users.locator('[data-testid="doc-column-row"]', { hasText: "email" }).first()
      .locator('[data-testid="doc-column-meta-edit-email"]').click();
    await page.waitForSelector('[data-testid="meta-display-name"]', { timeout: 5000 });
    check(
      "the column dialog shows the dictionary value as a placeholder",
      ((await page.locator('[data-testid="meta-display-name"]').getAttribute("placeholder")) ?? "").includes("メールアドレス"),
    );
    await typeInto(page.locator('[data-testid="meta-display-name"]'), "ログイン用メール");
    await page.locator('[data-testid="notes-apply"]').click();
    await page.waitForSelector('[data-testid="meta-display-name"]', { state: "detached", timeout: 15000 });
    await waitForFile(usersFile, "ログイン用メール");
    check("column logical name is written under meta.columns", /email: \{[^}]*displayName: "ログイン用メール"/.test(readFileSync(usersFile, "utf-8")));
    check("the column notes written earlier survive", readFileSync(usersFile, "utf-8").includes('notes: "ログイン ID を兼ねる"'));

    // ---- ER図: テーブル詳細ダイアログの上に制約の詳細・論理情報のダイアログが重なる ----
    const profilesFile = join(dir, "workspace-default", "data", "schema", "public", "user_profiles.js");
    await page.goto(`${url}#/w/default/erd/users`);
    await page.waitForSelector('.react-flow__node[data-id="public.user_profiles"]', { timeout: 15000 });
    await page.dblclick('.react-flow__node[data-id="public.user_profiles"]');
    await page.waitForSelector('[data-testid="lunique-list"]', { timeout: 15000 });
    check(
      "ER: the table dialog shows the edit pens in server mode",
      (await page.locator('[data-testid="table-meta-edit-public.user_profiles"]').count()) === 1 &&
        (await page.locator('[data-testid="column-meta-edit-full_name"]').count()) === 1,
    );
    await page.locator('[data-testid="lunique-list"] [data-testid="constraint-detail"]').click();
    await page.waitForSelector('[data-testid="constraint-notes-value"]', { timeout: 5000 });
    check("ER: the constraint dialog stacks on the table dialog", (await page.locator('[role="dialog"]').count()) === 2);
    await inlineEdit("constraint-notes-value", "1ユーザーにつきプロファイルは1件（ER図から）");
    await waitForFile(profilesFile, "（ER図から）");
    check("ER: the logical unique note is written from the ER dialog", readFileSync(profilesFile, "utf-8").includes('notes: "1ユーザーにつきプロファイルは1件（ER図から）"'));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1, null, { timeout: 5000 });
    check("ER: Esc closes only the top dialog; the table dialog remains", (await page.locator('[data-testid="lunique-list"]').count()) === 1);
    // テーブル詳細ダイアログの行末のペン → 論理情報のダイアログが重なる
    await page.locator('[data-testid="column-meta-edit-full_name"]').click();
    await page.waitForSelector('[data-testid="meta-display-name"]', { timeout: 5000 });
    check("ER: the logical info dialog stacks on the table dialog", (await page.locator('[role="dialog"]').count()) === 2);
    await typeInto(page.locator('[data-testid="meta-display-name"]'), "氏名");
    await page.locator('[data-testid="notes-apply"]').click();
    await page.waitForSelector('[data-testid="meta-display-name"]', { state: "detached", timeout: 15000 });
    await waitForFile(profilesFile, "氏名");
    check("ER: the column logical name is written from the table dialog", /full_name: \{[^}]*displayName: "氏名"/.test(readFileSync(profilesFile, "utf-8")));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="table-columns"]')?.textContent?.includes("氏名"),
      null,
      { timeout: 15000 },
    );
    check("ER: the table dialog stays open and reflects the change", (await page.locator('[role="dialog"]').count()) === 1);

    // ---- ER図: 論理一意制約を制約詳細から削除する（テーブル詳細は開いたまま） ----
    await page.locator('[data-testid="lunique-list"] [data-testid="constraint-detail"]').click();
    await page.waitForSelector('[data-testid="constraint-delete"]', { timeout: 5000 });
    await page.locator('[data-testid="constraint-delete"]').click();
    await page.waitForSelector('[data-testid="constraint-delete-confirm"]', { timeout: 5000 });
    await page.locator('[data-testid="constraint-delete-confirm"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1, null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="lunique-list"]') === null, null, { timeout: 15000 });
    check("ER: a logical unique can be deleted from the constraint dialog", !readFileSync(profilesFile, "utf-8").includes("luk_user_profiles_user"));
    check("ER: the table dialog stays open after the deletion", (await page.locator('[data-testid="table-columns"]').count()) === 1);

    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 });

    check("no page errors", errors.length === 0);
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
