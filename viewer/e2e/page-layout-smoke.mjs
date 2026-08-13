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
import { mkdirSync, mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
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
  const file = join(dir, "workspace-default", "data", "diagrams", `${page}.js`);
  if (!existsSync(file)) return null;
  const out = {};
  const re = /"([\w.]+)": \{ pos: \[(-?\d+), (-?\d+)\]/g;
  const text = readFileSync(file, "utf-8");
  for (const m of text.matchAll(re)) out[m[1]] = [Number(m[2]), Number(m[3])];
  return out;
}

function manifestText(dir) {
  return readFileSync(join(dir, "workspace-default", "data", "manifest.js"), "utf-8");
}

async function waitSaved(page) {
  // 自動保存は無い（H-03）。明示的に保存してから保存アイコンの data-status=saved を待つ。
  // 未保存が無ければ Ctrl+S は no-op（既に保存済みのまま）
  await page.keyboard.press("Control+s");
  await page.waitForSelector('[data-testid="save-button"][data-status="saved"]', { timeout: 15000 });
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
  // ワークスペースを1つ用意しておく（サーバーは起動時に workspace-* を走査して認識する）
  mkdirSync(join(dir, "workspace-default", "data"), { recursive: true });

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

    const res = await fetch(`http://127.0.0.1:${PORT}/__erd/w/default/bootstrap?t=${token}`, {
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

    await page.goto(`${url}#/w/default/erd/users`);
    await page.waitForSelector('[data-testid="erd-node"]', { timeout: 15000 });
    await page.click('[data-testid="session-toggle"]');
    await page.waitForSelector('[data-testid="session-toggle"][data-editing="true"]', { timeout: 5000 });

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
        existsSync(join(dir, "workspace-default", "data", "schema", "public", "user_sessions.js")));
    check("I-06: other nodes on the page are untouched",
        Object.keys(before).filter((k) => k !== "public.user_sessions")
            .every((k) => afterRemove[k]?.[0] === before[k][0] && afterRemove[k][1] === before[k][1]));

    // 「未配置」は index.tables[].diagrams が空という導出結果（K-12 §7.1）。
    // 左パネル「ページ」レーンの未配置疑似ページを選ぶとトレイが現れる（回答3）
    const V = '[data-testid="panel-slot"]:not([data-hidden]) '; // 表示中パネルに限定（両パネル常時マウント）
    await page.click(V + '[data-testid="unplaced-page"]');
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
    // トレイの消滅は保存後の index.js 再読込（非同期）に依存する。反映を待ってから確認する
    const trayGone = await page
        .waitForSelector('[data-testid="unplaced-tray"]', { state: "detached", timeout: 10000 })
        .then(() => true, () => false);
    check("K-12: tray is empty again once every table is placed", trayGone);

    // ---- 3. H-07: 全体レイアウトはプレビュー → 適用 → Undo 1回で完全に戻る（T-17） ----
    const beforeLayout = nodesInFile(dir, "users");
    await page.click('[data-testid="auto-layout"]');
    await page.waitForSelector('[data-testid="erd-node"][data-ghost="true"]', { timeout: 15000 });
    check("H-07: preview overlays the current placement as ghosts", true);
    check("H-07: nothing is written while previewing",
        JSON.stringify(nodesInFile(dir, "users")) === JSON.stringify(beforeLayout));

    await page.click('[data-testid="erd-layout-preview"] button:nth-of-type(1)'); // 適用
    await waitSaved(page);
    const afterLayout = nodesInFile(dir, "users");
    check("H-07: applying the layout moves nodes",
        Object.keys(beforeLayout).some((k) => afterLayout[k][0] !== beforeLayout[k][0]
            || afterLayout[k][1] !== beforeLayout[k][1]));
    check("H-07: every coordinate stays on the 8px grid",
        Object.values(afterLayout).every(([x, y]) => x % 8 === 0 && y % 8 === 0));
    check("H-07: ghosts are gone after applying",
        (await page.locator('[data-testid="erd-node"][data-ghost="true"]').count()) === 0);

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

    await page.click(V + '[data-testid="unplaced-page"]');
    await page.waitForSelector('[data-testid="unplaced-tray"]');
    await page.locator('[data-testid="unplaced-tray"] [data-testid="tray-item"]').first()
        .dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 200, y: 500 } });
    await page.waitForSelector('.react-flow__node[data-id="public.user_sessions"]', { timeout: 10000 });
    // ドロップした時点で未配置ではなくなる（index.js は保存後にしか更新されないが、
    // 一覧は保存前の配置（view）も見る）
    const trayGoneBeforeSave = await page
        .waitForSelector('[data-testid="unplaced-tray"]', { state: "detached", timeout: 5000 })
        .then(() => true, () => false);
    check("K-12: a dragged table leaves the unplaced list before saving", trayGoneBeforeSave);
    await waitSaved(page);
    const dropped = nodesInFile(dir, "users")["public.user_sessions"];
    check("I-04: dropping a tray item onto the canvas places it",
        dropped !== undefined && dropped[0] % 8 === 0 && dropped[1] % 8 === 0);

    // ---- 4. I-01: ページの追加 ----
    // ページ管理（追加・改名・並び替え・削除）は即時反映のため、ER図の配置編集とは
    // 導線を分けてある。ER編集中は開けない（相互排他）
    check("page info editing is locked while editing the diagram",
        await page.locator(V + '[data-testid="page-info-toggle"]').isDisabled());
    check("page management is hidden until the dialog is opened",
        (await page.locator('[data-testid="page-add"]').count()) === 0);

    // ---- 3b. 左パネルの行から編集画面への近道 / Esc での編集解除 ----
    // 編集中は近道を出さない（踏むと編集ルートを離れ、未保存の配置が捨てられるため）
    check("the row shortcut to the table editor is hidden while editing",
        (await page.locator(V + '[data-testid="lp-edit-table"]').count()) === 0);

    // 入力欄にフォーカスがあるときの Esc は横取りしない（入力の取り消しに使うため）
    await page.click(V + '[data-testid="lane-all"]');
    await page.waitForSelector(V + '[data-testid="lp-filter"]', { timeout: 5000 });
    await page.locator(V + '[data-testid="lp-filter"]').first().click();
    await page.keyboard.press("Escape");
    check("Esc inside an input does not end the edit session",
        (await page.locator('[data-testid="session-toggle"][data-editing="true"]').count()) === 1);

    // ER図の編集を終えてからページ情報の編集へ入る（終了は Esc でも [編集終了] と同じ経路）
    await page.click(V + '[data-testid="lane-pages"]'); // 入力欄からフォーカスを外す
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="session-toggle"][data-editing="false"]', { timeout: 5000 });
    check("Esc ends the diagram edit session", true);

    // 閲覧に戻れば近道が出る（href はテーブル編集ルートを指す）
    await page.waitForSelector(V + '[data-testid="lp-edit-table"]', { timeout: 5000 });
    check("the row shortcut points at the table edit route",
        (await page.locator(V + '[data-testid="lp-edit-table"]').first().getAttribute("href"))
          ?.endsWith("/edit") === true);

    // 管理はダイアログの中で完結する（左パネルが編集用の見た目に変わらない）
    await page.click(V + '[data-testid="page-info-toggle"]');
    await page.waitForSelector('[data-testid="page-manage-list"]', { timeout: 5000 });
    check("the page management dialog opens from the panel",
        (await page.locator('[data-testid="page-manage-row"]').count()) >= 1);
    check("diagram editing cannot start while the page dialog is open",
        await page.locator('[data-testid="session-toggle"]').isDisabled());
    // ダイアログを開いている間も近道は出さない（そちらの操作に集中させる）
    check("the row shortcut is hidden while managing pages",
        (await page.locator(V + '[data-testid="lp-edit-table"]').count()) === 0);

    // 追加も同じダイアログの中で開く（ダイアログの上にダイアログを重ねない）
    await page.click('[data-testid="page-add"]');
    await page.waitForSelector('[data-testid="page-id"]', { timeout: 5000 });
    check("the add form opens inside the same dialog",
        (await page.locator('[role="dialog"]').count()) === 1);
    // 開いた直後からページID を打てる
    await page.keyboard.type("billing");
    check("the add-page dialog focuses the page id input",
        (await page.inputValue('[data-testid="page-id"]')) === "billing");
    await page.locator('[data-testid="page-title"]').pressSequentially("課金");
    await page.click('[data-testid="page-create"]');
    check("I-01: new page file is written",
        await waitFile(() => existsSync(join(dir, "workspace-default", "data", "diagrams", "billing.js"))));
    check("I-01: manifest lists the new page",
        await waitFile(() => manifestText(dir).includes('id: "billing"')));
    await page.waitForFunction(() => location.hash === "#/w/default/erd/billing", { timeout: 5000 });
    check("I-01: the new page is empty (no nodes)",
        Object.keys(nodesInFile(dir, "billing")).length === 0);
    check("I-01: every table is now unplaced-free but the tray stays empty",
        (await page.locator('[data-testid="unplaced-tray"]').count()) === 0);

    // 作ったページへ移動し、管理ダイアログは閉じる（そのページを見せる）
    await page.waitForSelector(V + '[data-testid="page-info-toggle"][data-editing="false"]', { timeout: 5000 });
    check("creating a page closes the management dialog",
        (await page.locator('[data-testid="page-manage-list"]').count()) === 0);
    // 新規ページ作成後は閲覧ルートに着地する。配置するには編集ルートへ
    await page.click('[data-testid="session-toggle"]');
    await page.waitForSelector('[data-testid="session-toggle"][data-editing="true"]', { timeout: 5000 });

    // 編集中は共通ヘッダのほかのナビが押せない（踏むと編集ルートを離れて編集が終わるため）
    check("diagram editing disables the other nav links",
        (await page.locator('nav [data-disabled="true"]').count()) === 3);
    // ページを選んでも編集ルートのまま（編集が終わらない）
    await page.click(V + '[data-testid="lane-pages"]');
    await page.click(V + '[data-testid="page-row"] button');
    await page.waitForFunction(() => location.hash.endsWith("/edit"), null, { timeout: 5000 });
    check("selecting a page keeps the edit route", true);
    await page.goto(`${url}#/w/default/erd/billing/edit`);
    await page.waitForSelector('[data-testid="erd-edit-toolbar"]', { timeout: 10000 });

    // ---- 4b. I-04 / §5.9: 別ページに配置済みのテーブルを、この空ページへ配置する ----
    // users ページにあるテーブルを billing にも足す（移動ではなく複数ページ配置）
    const usersBefore = nodesInFile(dir, "users");

    // 配置済みテーブルの現在ページへの追加は「全て」レーンから行う（add-to-page はこのレーン）
    await page.click(V + '[data-testid="lane-all"]');
    await page.waitForSelector(V + '[data-testid="lp-item"]', { timeout: 5000 });

    // (a) ＋ ボタン（ドラッグ以外の導線）
    await page.getByTestId("add-to-page-public.roles").click();
    await page.waitForSelector('.react-flow__node[data-id="public.roles"]', { timeout: 20000 });
    await waitSaved(page);
    check("I-04: the + button adds an already-placed table to the current page",
        nodesInFile(dir, "billing")["public.roles"] !== undefined);

    // (b) サイドバーからキャンバスへドラッグ
    await page
        .locator('[data-testid="lp-item"]:has([data-testid="add-to-page-public.user_profiles"]) [data-testid="table-item"]')
        .dragTo(page.locator(".react-flow__pane"), { targetPosition: { x: 300, y: 300 } });
    await page.waitForSelector('.react-flow__node[data-id="public.user_profiles"]', { timeout: 20000 });
    await waitSaved(page);
    check("I-04: dragging a placed table from the sidebar adds it to the current page",
        nodesInFile(dir, "billing")["public.user_profiles"] !== undefined);

    // §5.9: 元のページからは消えていない（移動ではなく複数ページ配置）
    const usersAfter = nodesInFile(dir, "users");
    check("§5.9: the table remains on its original page (placed on both, not moved)",
        usersAfter["public.roles"] !== undefined
        && usersAfter["public.user_profiles"] !== undefined
        && JSON.stringify(usersAfter) === JSON.stringify(usersBefore));

    // 同じテーブルをもう一度足しても二重配置にならない（makeAdd がスキップする）
    const billingCount = Object.keys(nodesInFile(dir, "billing")).length;
    await page.getByTestId("add-to-page-public.roles").count().then(async (n) => {
      // roles は billing に載ったので ＋ ではなく ✓ になっている（＋ は出ない）
      check("I-04: a table already on the page shows no + button", n === 0);
    });
    check("I-04: no double placement", Object.keys(nodesInFile(dir, "billing")).length === billingCount);

    // ---- 5. I-03: 改名 → manifest とページファイルの両方に反映される ----
    // ページ管理はダイアログの中（ER図の編集中は開けないので、そちらを終える）
    await page.click(V + '[data-testid="lane-pages"]');
    await page.click('[data-testid="session-toggle"][data-editing="true"]');
    await page.waitForSelector('[data-testid="session-toggle"][data-editing="false"]', { timeout: 5000 });
    await page.click(V + '[data-testid="page-info-toggle"]');
    await page.waitForSelector('[data-testid="page-rename-billing"]', { timeout: 5000 });
    await page.click('[data-testid="page-rename-billing"]');
    // 改名も行の中で行う（重ねたダイアログにしない）
    check("renaming happens inside the same dialog",
        (await page.locator('[role="dialog"]').count()) === 1);
    await page.locator('[data-testid="page-rename-input"]').fill("");
    await page.locator('[data-testid="page-rename-input"]').pressSequentially("課金ドメイン");
    await page.click('[data-testid="page-rename-save"]');
    check("I-03: rename is reflected in manifest.js",
        await waitFile(() => manifestText(dir).includes("課金ドメイン")));
    check("I-03: rename is reflected in the page file",
        readFileSync(join(dir, "workspace-default", "data", "diagrams", "billing.js"), "utf-8").includes("課金ドメイン"));

    // ---- 6. I-03: 並び替え（billing は末尾 → 1つ上へ） ----
    const orderBefore = manifestText(dir).indexOf('id: "billing"');
    await page
        .locator('[data-testid="page-manage-row"]:has([data-testid="page-delete-billing"]) button[title="上へ"]')
        .click();
    check("I-03: reordering moves the page up in manifest.js",
        await waitFile(() => manifestText(dir).indexOf('id: "billing"') < orderBefore));

    // ---- 7. I-02: 削除（スキーマ情報には影響しない） ----
    await page.click('[data-testid="page-delete-billing"]');
    // 確認も行の中。押し間違いで即座に消えないよう一段挟む
    check("deleting asks for confirmation in the row",
        (await page.locator('[role="dialog"]').count()) === 1
        && (await page.locator('[data-testid="page-delete-confirm"]').count()) === 1);
    await page.click('[data-testid="page-delete-confirm"]');
    check("I-02: page file is deleted",
        await waitFile(() => !existsSync(join(dir, "workspace-default", "data", "diagrams", "billing.js"))));
    check("I-02: manifest no longer lists the page",
        !manifestText(dir).includes('id: "billing"'));
    check("I-02: table definitions are untouched",
        existsSync(join(dir, "workspace-default", "data", "schema", "public", "users.js")));

    // 管理を終えるのは Esc / [閉じる]（モードの解除ではなくダイアログを閉じるだけ）
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="page-manage-list"]', { state: "detached", timeout: 5000 });
    check("Esc closes the page management dialog",
        (await page.locator(V + '[data-testid="page-info-toggle"][data-editing="false"]').count()) === 1);

    // ---- 7b. I-03: 一度も編集セッションに入らずに改名できる（baseHash の取り直し） ----
    // ページ管理は ER図の編集（enterEditing）とは相互排他なので、読み込んだだけの画面から
    // 開かれる。baseHash を編集開始時にしか取っていないと、ここが必ず 409 STALE になり、
    // 「外部で変更されています」が再読込しても消えなくなる（回帰防止）
    // ハッシュだけの goto は同一ドキュメント遷移になり JS の状態が残るため reload で読み直す。
    // 直前の書き込みに対するファイル監視イベント（SSE）が読み直しの後に届くと、その追随で
    // baseHash が埋まってしまい再現しない。落ち着くまで待ってから読み直す
    await page.goto(`${url}#/w/default/erd/users`);
    await new Promise((r) => setTimeout(r, 3000));
    await page.reload();
    await page.waitForSelector('.react-flow__node', { timeout: 15000 });
    await page.click(V + '[data-testid="lane-pages"]');
    await page.click(V + '[data-testid="page-info-toggle"]');
    await page.waitForSelector('[data-testid="page-rename-users"]', { timeout: 5000 });
    await page.click('[data-testid="page-rename-users"]');
    await page.locator('[data-testid="page-rename-input"]').fill("");
    await page.locator('[data-testid="page-rename-input"]').pressSequentially("利用者ドメイン");
    await page.click('[data-testid="page-rename-save"]');
    check("I-03: renaming works without ever entering the edit session",
        await waitFile(() => manifestText(dir).includes("利用者ドメイン")));
    check("I-03: no stale error is shown after that rename",
        (await page.locator(".form-error").count()) === 0);
    await page.keyboard.press("Escape");

    check("no page errors (server mode)", pageErrors.length === 0);
    await page.close();

    // ---- 8. 静的モード: 自動レイアウトは使えない（ELK はサーバー側。詳細設計 §8.1） ----
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    const staticPage = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    await staticPage.goto("file:///" + join(dir, "index.html").replaceAll("\\", "/") + "#/w/default/erd/users");
    await staticPage.waitForSelector('[data-testid="erd-node"]', { timeout: 15000 });
    // 静的モードでも [編集開始] で編集ルートへ入れる（ロック無し・保存不可）
    await staticPage.click('[data-testid="session-toggle"]');
    await staticPage.waitForSelector('[data-testid="session-toggle"][data-editing="true"]');
    check("static mode: auto layout is disabled",
        await staticPage.locator('[data-testid="auto-layout"]').isDisabled());
    check("static mode: page management is not offered",
        (await staticPage.locator('[data-testid="page-add"]').count()) === 0
        && (await staticPage.locator('[data-testid="page-info-toggle"]').count()) === 0);

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
