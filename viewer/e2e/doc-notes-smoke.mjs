/**
 * ドキュメントモードからの注記編集（R-05）のスモークテスト（サーバーモード）。
 *
 * - サンプルデータを取り込み、ドキュメント（`#/tables/doc/<id>`）を開く
 * - 見出しのペンからテーブル注記を書く → 確定で即時保存され、schema/**.js に `notes` が書かれる
 * - 行のペンからカラム注記を書く → `meta.columns[].notes` が書かれ、画面にも反映される
 * - 外部でファイルを書き換えた後に保存しても、その変更を踏み潰さない（読み直してから書く）
 * - 注記を空にして確定すると `notes` キーが消える
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
    check("server mode shows the notes pens", (await users.locator('[data-testid="doc-table-notes-edit-public.users"]').count()) === 1);

    // ---- テーブル注記 ----
    await users.locator('[data-testid="doc-table-notes-edit-public.users"]').click();
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
    await emailRow.locator('[data-testid="doc-column-notes-edit-email"]').click();
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
    await users.locator('[data-testid="doc-table-notes-edit-public.users"]').click();
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

    // ---- ヘッダの編集ペンはドキュメントでも出て、読んでいる位置のテーブルを編集する。終了後は最後のモードへ戻る ----
    const startEdit = page.locator('[data-testid="session-toggle"][data-editing="false"]');
    check("the header edit button is shown in doc mode", (await startEdit.count()) === 1);
    // 保存直後の再描画が落ち着くのを待つ（読んでいる位置は users のまま）
    await page.waitForFunction(
      () => document.querySelector('[data-testid="session-toggle"][data-editing="false"]')?.getAttribute("href") === "#/w/default/tables/public.users/edit",
      null,
      { timeout: 15000 },
    );
    check("the header edit button targets the table being read", true);
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
    await items.locator('[data-testid="column-notes-edit-quantity"]').click();
    await applyNotes("1 以上");
    await items.locator('[data-testid="column-notes-quantity"]').waitFor({ timeout: 15000 });
    check("detail: column notes can be edited and show up as the note icon", true);
    // 物理FK の多重度の補足（meta.relations）
    await items.locator('[data-testid="fk-notes-edit-order_items_order_id_fkey"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="notes-input"]')?.value === "注文には必ず1明細以上が存在する", null, { timeout: 5000 });
    check("detail: the physical FK pen opens with the current cardinality note", true);
    await applyNotes("注文には必ず1明細以上が存在する（変更）");
    await waitForFile(itemsFile, "注文には必ず1明細以上が存在する（変更）");
    // 論理外部制約の注記
    await items.locator('[data-testid="lfk-notes-edit-0"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="notes-input"]')?.value?.startsWith("在庫への論理参照"), null, { timeout: 5000 });
    await applyNotes("在庫への論理参照（変更）");
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
    await items.locator('[data-testid="table-notes-edit-public.order_items"]').click();
    await applyNotes("詳細から書いたテーブル注記");
    await page.waitForFunction(
      () => document.querySelector('[data-doc-table="public.order_items"] [data-testid="table-notes-text"]')?.textContent?.includes("詳細から書いたテーブル注記"),
      null,
      { timeout: 15000 },
    );
    check("detail: table notes can be edited", readFileSync(itemsFile, "utf-8").includes('notes: "詳細から書いたテーブル注記"'));
    check("detail: editing keeps the URL in detail mode", page.url().includes("#/w/default/tables/public.order_items"));

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
