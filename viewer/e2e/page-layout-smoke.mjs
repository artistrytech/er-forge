/**
 * ページ管理・未配置トレイ・自動レイアウトのスモークテスト（フェーズ6の完了条件）。
 *
 * - I-06 / N-04: ノードをページから除去 → スキーマは残り、未配置トレイに現れる（K-12）
 * - K-12 / I-04 / H-08: トレイから自動配置 → **既存ノードの座標は1つも動かない**（T-16）
 * - H-07: 全体レイアウトはプレビュー（現配置をゴーストで重ねる）→ 適用 → Ctrl+Z で完全に戻る（T-17）
 * - I-01 / I-02 / I-03: ページの追加 / 改名 / 並び替え / 削除（manifest.js が追随する）
 * - 静的モード: 自動レイアウトは ELK（サーバー API）に依存するため使えない
 *
 * 前提: `npm run build` と `gradlew shadowJar` 済み。実行: `npm run e2e:pages`
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const JAR = resolve(here, "..", "..", "server", "build", "libs", "erd-server.jar");
const INDEX = resolve(here, "..", "dist", "index.html");
const PORT = 5372;

const results = [];
function check(name, cond) {
  results.push(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond) process.exitCode = 1;
}

function javaBin() {
  if (process.env.JAVA_HOME) return join(process.env.JAVA_HOME, "bin", "java");
  return "java";
}

/** ダイアグラムファイルの nodes を { tableId: [x, y] } として読む */
function nodesInFile(dir, page) {
  const file = join(dir, "data", "diagrams", `${page}.js`);
  if (!existsSync(file)) return null;
  const out = {};
  const re = /"([\w.]+)": \{ pos: \[(-?\d+), (-?\d+)\]/g;
  const text = readFileSync(file, "utf-8");
  for (const m of text.matchAll(re)) out[m[1]] = [Number(m[2]), Number(m[3])];
  return out;
}

function manifestText(dir) {
  return readFileSync(join(dir, "data", "manifest.js"), "utf-8");
}

async function waitSaved(page) {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="save-status"]');
      return el !== null && (el.textContent.includes("保存済み") || el.textContent.includes("Saved"));
    },
    { timeout: 15000 },
  );
}

/** ファイルが条件を満たすまで待つ（ページ管理 API は保存ステータスを動かさない） */
async function waitFile(fn, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  if (!existsSync(JAR) || !existsSync(INDEX)) {
    console.error("erd-server.jar / dist/index.html がありません。先にビルドしてください。");
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "erd-pages-"));
  copyFileSync(INDEX, join(dir, "index.html"));

  const proc = spawn(javaBin(), ["-jar", JAR], {
    cwd: dir,
    env: { ...process.env, ERD_NO_BROWSER: "1", ERD_PORT: String(PORT) },
  });
  let url = null;
  proc.stdout.on("data", (d) => {
    const m = String(d).match(/ERD server: (http:\/\/[^\s]+)/);
    if (m) url = m[1];
  });

  let browser;
  try {
    for (let i = 0; i < 100 && url === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (url === null) throw new Error("server did not start");
    const token = new URL(url).searchParams.get("t");

    const res = await fetch(`http://127.0.0.1:${PORT}/__erd/bootstrap?t=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "sample" }),
    });
    if (res.status !== 200) throw new Error("bootstrap failed: " + res.status);

    for (const channel of ["msedge", "chrome"]) {
      try {
        browser = await chromium.launch({ channel });
        break;
      } catch {
        // 次の channel
      }
    }
    if (!browser) browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(`${url}#/erd/users`);
    await page.waitForSelector(".erd-node", { timeout: 15000 });
    await page.click('[data-testid="session-toggle"]');
    await page.waitForSelector(".session-editing", { timeout: 5000 });

    const before = nodesInFile(dir, "users");

    // ---- 1. I-06 / N-04: ページから除去 → 未配置トレイへ（K-12） ----
    await page.click('.react-flow__node[data-id="public.user_sessions"]');
    await page.click('[data-testid="remove-node"]');
    await page.click('[data-testid="remove-confirm"]');
    await waitSaved(page);

    const afterRemove = nodesInFile(dir, "users");
    check("I-06: removed node is gone from the page file",
        afterRemove["public.user_sessions"] === undefined);
    check("I-06: schema file remains (definition is not deleted)",
        existsSync(join(dir, "data", "schema", "public", "user_sessions.js")));
    check("I-06: other nodes on the page are untouched",
        Object.keys(before).filter((k) => k !== "public.user_sessions")
            .every((k) => afterRemove[k]?.[0] === before[k][0] && afterRemove[k][1] === before[k][1]));

    // 「未配置」は index.tables[].diagrams が空という導出結果（K-12 §7.1）
    await page.waitForSelector('[data-testid="unplaced-tray"]', { timeout: 10000 });
    const inTray = await page.locator('[data-testid="unplaced-tray"]').textContent();
    check("K-12: removed table appears in the unplaced tray", inTray.includes("user_sessions"));

    // ---- 2. K-12 / I-04 / H-08: 自動配置は既存ノードを1つも動かさない（T-16） ----
    const beforePlace = nodesInFile(dir, "users");
    await page.click('[data-testid="tray-auto-place"]');
    // 自動配置は ELK への往復を挟む。ノードが現れてから保存の完了を待つ
    await page.waitForSelector('.react-flow__node[data-id="public.user_sessions"]', { timeout: 15000 });
    await waitSaved(page);

    const afterPlace = nodesInFile(dir, "users");
    const placed = afterPlace["public.user_sessions"];
    check("H-08: unplaced table is placed on the page", placed !== undefined);
    check("H-08: placed pos is on the 8px grid (INV-2)",
        placed[0] % 8 === 0 && placed[1] % 8 === 0);
    check("H-08 / T-16: existing node coordinates are unchanged",
        Object.keys(beforePlace).every(
            (k) => afterPlace[k][0] === beforePlace[k][0] && afterPlace[k][1] === beforePlace[k][1]));
    check("K-12: tray is empty again once every table is placed",
        (await page.locator('[data-testid="unplaced-tray"]').count()) === 0);

    // ---- 3. H-07: 全体レイアウトはプレビュー → 適用 → Undo 1回で完全に戻る（T-17） ----
    const beforeLayout = nodesInFile(dir, "users");
    await page.click('[data-testid="auto-layout"]');
    await page.waitForSelector(".erd-node-ghost", { timeout: 15000 });
    check("H-07: preview overlays the current placement as ghosts", true);
    check("H-07: nothing is written while previewing",
        JSON.stringify(nodesInFile(dir, "users")) === JSON.stringify(beforeLayout));

    await page.click(".erd-layout-preview button:nth-of-type(1)"); // 適用
    await waitSaved(page);
    const afterLayout = nodesInFile(dir, "users");
    check("H-07: applying the layout moves nodes",
        Object.keys(beforeLayout).some((k) => afterLayout[k][0] !== beforeLayout[k][0]
            || afterLayout[k][1] !== beforeLayout[k][1]));
    check("H-07: every coordinate stays on the 8px grid",
        Object.values(afterLayout).every(([x, y]) => x % 8 === 0 && y % 8 === 0));
    check("H-07: ghosts are gone after applying",
        (await page.locator(".erd-node-ghost").count()) === 0);

    // 50ノード動かしても moveNodes 1個 = Undo 1回で完全に戻る
    await page.keyboard.press("Control+z");
    await waitSaved(page);
    const afterUndo = nodesInFile(dir, "users");
    check("H-07 / T-17: Ctrl+Z restores every node exactly",
        JSON.stringify(afterUndo) === JSON.stringify(beforeLayout));

    // ---- 3b. N-04（Delete キー）と I-04（トレイ → キャンバスへのドラッグ） ----
    await page.click('.react-flow__node[data-id="public.user_sessions"]');
    await page.keyboard.press("Delete");
    await page.click('[data-testid="remove-confirm"]');
    await waitSaved(page);
    check("N-04: Delete key removes the selected node",
        nodesInFile(dir, "users")["public.user_sessions"] === undefined);

    await page.waitForSelector('[data-testid="unplaced-tray"]');
    await page.locator('[data-testid="unplaced-tray"] .tray-item').first()
        .dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 200, y: 500 } });
    await page.waitForSelector('.react-flow__node[data-id="public.user_sessions"]', { timeout: 10000 });
    await waitSaved(page);
    const dropped = nodesInFile(dir, "users")["public.user_sessions"];
    check("I-04: dropping a tray item onto the canvas places it",
        dropped !== undefined && dropped[0] % 8 === 0 && dropped[1] % 8 === 0);

    // ---- 4. I-01: ページの追加 ----
    await page.click('[data-testid="page-add"]');
    await page.locator('[data-testid="page-id"]').pressSequentially("billing");
    await page.locator('[data-testid="page-title"]').pressSequentially("課金");
    await page.click('[data-testid="page-create"]');
    check("I-01: new page file is written",
        await waitFile(() => existsSync(join(dir, "data", "diagrams", "billing.js"))));
    check("I-01: manifest lists the new page",
        await waitFile(() => manifestText(dir).includes('id: "billing"')));
    await page.waitForFunction(() => location.hash === "#/erd/billing", { timeout: 5000 });
    check("I-01: the new page is empty (no nodes)",
        Object.keys(nodesInFile(dir, "billing")).length === 0);
    check("I-01: every table is now unplaced-free but the tray stays empty",
        (await page.locator('[data-testid="unplaced-tray"]').count()) === 0);

    // ---- 5. I-03: 改名 → manifest とページファイルの両方に反映される ----
    await page.click('[data-testid="page-rename-billing"]');
    await page.locator('[data-testid="page-rename-input"]').fill("");
    await page.locator('[data-testid="page-rename-input"]').pressSequentially("課金ドメイン");
    await page.click('[data-testid="page-rename-save"]');
    check("I-03: rename is reflected in manifest.js",
        await waitFile(() => manifestText(dir).includes("課金ドメイン")));
    check("I-03: rename is reflected in the page file",
        readFileSync(join(dir, "data", "diagrams", "billing.js"), "utf-8").includes("課金ドメイン"));

    // ---- 6. I-03: 並び替え（billing は末尾 → 1つ上へ） ----
    const orderBefore = manifestText(dir).indexOf('id: "billing"');
    await page
        .locator('.sidebar-page-row:has([data-testid="page-delete-billing"]) button[title="上へ"]')
        .click();
    check("I-03: reordering moves the page up in manifest.js",
        await waitFile(() => manifestText(dir).indexOf('id: "billing"') < orderBefore));

    // ---- 7. I-02: 削除（スキーマ情報には影響しない） ----
    await page.click('[data-testid="page-delete-billing"]');
    await page.click('[data-testid="page-delete-confirm"]');
    check("I-02: page file is deleted",
        await waitFile(() => !existsSync(join(dir, "data", "diagrams", "billing.js"))));
    check("I-02: manifest no longer lists the page",
        !manifestText(dir).includes('id: "billing"'));
    check("I-02: table definitions are untouched",
        existsSync(join(dir, "data", "schema", "public", "users.js")));

    check("no page errors (server mode)", pageErrors.length === 0);
    await page.close();

    // ---- 8. 静的モード: 自動レイアウトは使えない（ELK はサーバー側。詳細設計 §8.1） ----
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    const staticPage = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    await staticPage.goto("file:///" + join(dir, "index.html").replaceAll("\\", "/") + "#/erd/users");
    await staticPage.waitForSelector(".erd-node", { timeout: 15000 });
    await staticPage.click('[data-testid="session-toggle"]');
    await staticPage.click('[data-testid="static-edit-ok"]');
    await staticPage.waitForSelector(".session-editing");
    check("static mode: auto layout is disabled",
        await staticPage.locator('[data-testid="auto-layout"]').isDisabled());
    check("static mode: page management is not offered",
        (await staticPage.locator('[data-testid="page-add"]').count()) === 0);

    await browser.close();
    browser = null;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows ではプロセス終了直後の削除が失敗することがある
    }
  }
}

main().then(
  () => {
    console.log(results.join("\n"));
    console.log(process.exitCode ? "PAGE/LAYOUT SMOKE FAILED" : "PAGE/LAYOUT SMOKE OK");
  },
  (e) => {
    console.log(results.join("\n"));
    console.error(e);
    process.exit(1);
  },
);
