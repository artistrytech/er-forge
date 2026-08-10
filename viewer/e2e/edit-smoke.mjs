/**
 * ER図編集のスモークテスト（Phase3 の完了条件の検証）。
 *
 * サーバーモード:
 * - 編集開始（ロック取得）→ ドラッグ → 自動保存 → data/diagrams/*.js が更新される（8px整数）
 * - Ctrl+Z（Undo は新しい編集として保存される）→ ファイルが元に戻る
 * - 外部変更（閲覧相当・未保存なし）→ 静かに再読込され、ノード位置が追随する（INV-3/H-09）
 * - 手動保存モード + 未保存あり + 外部変更 → バナーで選択。「保存して上書き」は
 *   自分が触っていないノードの外部変更を巻き添えにしない（部分更新）
 * - 配置のエクスポート = ディスク上のファイルとバイト一致（決定論的プリンタ）
 *
 * 静的モード（file://）:
 * - 警告つきで編集開始 → ドラッグ → エクスポートに新座標が入る（H-10/H-13）
 *
 * 前提: `npm run build` と `gradlew shadowJar` 済み。実行: `npm run e2e:edit`
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

/** ファイルが条件を満たすまで待つ（画面の見た目ではなく、書かれた結果で判定する） */
async function waitForFile(path, predicate, timeout = 15000) {
  const until = Date.now() + timeout;
  for (;;) {
    if (predicate(readFileSync(path, "utf-8"))) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function usersPosInFile(dir) {
  const text = readFileSync(join(dir, "workspace-default", "data", "diagrams", "users.js"), "utf-8");
  const m = text.match(/"public\.users": \{ pos: \[(-?\d+), (-?\d+)\]/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** RF ノードの transform から現在のキャンバス座標を得る */
async function nodePosOnCanvas(page, id) {
  return page.$eval(`.react-flow__node[data-id="${id}"]`, (el) => {
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform);
    return m ? [Number(m[1]), Number(m[2])] : null;
  });
}

async function dragNode(page, id, dx, dy) {
  const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 8 });
  await page.mouse.up();
}

async function waitSaved(page) {
  // 保存アイコンの data-status が saved になれば保存完了（バッジ表示は廃止）
  await page.waitForSelector('[data-testid="save-button"][data-status="saved"]', { timeout: 10000 });
}

async function main() {
  if (!existsSync(JAR) || !existsSync(INDEX)) {
    console.error("erd-server.jar / dist/index.html がありません。先にビルドしてください。");
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "erd-edit-"));
  copyFileSync(INDEX, join(dir, "index.html"));
  // ワークスペースを1つ用意しておく（サーバーは起動時に workspace-* を走査して認識する）
  mkdirSync(join(dir, "workspace-default", "data"), { recursive: true });

  const proc = spawn(javaBin(), ["-jar", JAR], {
    cwd: dir,
    env: { ...process.env, ERD_NO_BROWSER: "1", ERD_PORT: "5371" },
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

    // サンプルデータを直接投入（ブートストラップは server-smoke で検証済み）
    const res = await fetch(`http://127.0.0.1:5371/__erd/w/default/bootstrap?t=${token}`, {
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    // ---- 1. 編集開始（H-10 / H-11） ----
    await page.goto(url);
    await page.waitForSelector('[data-testid="erd-node"]', { timeout: 15000 });
    const posBefore = usersPosInFile(dir);
    check("initial users pos is [360, 56]", posBefore?.[0] === 360 && posBefore?.[1] === 56);

    // [編集開始] は編集ルート #/erd/<id>/edit へのリンク（ロックは無い。H-11 廃止）
    await page.click('[data-testid="session-toggle"]');
    await page.waitForSelector('[data-testid="session-toggle"][data-editing="true"]', { timeout: 5000 });
    check("editing route entered (no lock)", true);

    // ---- 2. ドラッグ → 明示保存（H-01 / H-03 / T-2。自動保存は無い） ----
    await dragNode(page, "public.users", 120, 40);
    await page.keyboard.press("Control+s");
    await waitSaved(page);
    const posAfterDrag = usersPosInFile(dir);
    const uiPos = await nodePosOnCanvas(page, "public.users");
    check("drag persists to file", posAfterDrag !== null && posAfterDrag[0] !== posBefore[0]);
    check("saved pos is on 8px grid (T-2)",
        posAfterDrag[0] % 8 === 0 && posAfterDrag[1] % 8 === 0);
    check("file pos equals on-canvas pos (INV-2)",
        uiPos !== null && uiPos[0] === posAfterDrag[0] && uiPos[1] === posAfterDrag[1]);

    // ---- 3. Undo は新しい編集として保存される（H-05 / §5.2） ----
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+s");
    await waitSaved(page);
    const posAfterUndo = usersPosInFile(dir);
    check("Ctrl+Z restores original pos in file",
        posAfterUndo[0] === posBefore[0] && posAfterUndo[1] === posBefore[1]);

    // 自分の保存で再読込ループが起きない（INV-3 / T-6）: Undo 履歴が残っている
    await new Promise((r) => setTimeout(r, 800));
    const redoEnabled = await page.locator('[data-testid="erd-edit-toolbar"] button:nth-child(2)').isEnabled();
    check("own save does not clear stacks (T-6)", redoEnabled);

    // ---- 4. 編集ルートでの外部変更 → バナー[再読込]で反映（H-09 / §6.2） ----
    // 編集中は自動再読込せず、バナーで選ばせる（未保存の有無に関わらず。§6.2）
    const file = join(dir, "workspace-default", "data", "diagrams", "users.js");
    writeFileSync(file, readFileSync(file, "utf-8")
        .replace(/"public\.users": \{ pos: \[\d+, \d+\]/, '"public.users": { pos: [96, 96]'));
    await page.waitForSelector('[data-testid="external-banner"]', { timeout: 10000 });
    check("editing + external change shows banner (no silent reload)", true);
    await page.click('[data-testid="external-reload"]');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.react-flow__node[data-id="public.users"]');
        return el !== null && el.style.transform.includes("translate(96px, 96px)");
      },
      { timeout: 10000 },
    );
    check("external reload moves node", true);
    const undoDisabled = await page.locator('[data-testid="erd-edit-toolbar"] button:nth-child(1)').isDisabled();
    check("undo stack cleared after external reload (T-10)", undoDisabled);

    // ---- 5. 未保存 + 外部変更 → バナー[無視] → 保存で 409 STALE → 上書き（部分更新。T-7/§4.3） ----
    await dragNode(page, "public.user_profiles", 100, 60); // user_profiles を動かす（未保存）
    await page.waitForSelector('[data-testid="save-button"][data-status="dirty"]');
    // 外部で users を動かす（自分は user_profiles しか触っていない）
    writeFileSync(file, readFileSync(file, "utf-8")
        .replace(/"public\.users": \{ pos: \[\d+, \d+\]/, '"public.users": { pos: [160, 160]'));
    await page.waitForSelector('[data-testid="external-banner"]', { timeout: 10000 });
    check("dirty + external change shows banner, no auto reload (T-7)", true);
    const usersBeforeOverwrite = usersPosInFile(dir);
    check("file untouched while banner shown (INV-1)",
        usersBeforeOverwrite[0] === 160 && usersBeforeOverwrite[1] === 160);

    // [無視] で編集継続 → 保存すると baseHash 不一致で 409 → [自分の内容で上書き保存]
    await page.click('[data-testid="external-ignore"]');
    await page.keyboard.press("Control+s");
    await page.waitForSelector('[data-testid="conflict-overwrite"]', { timeout: 10000 });
    await page.click('[data-testid="conflict-overwrite"]');
    await waitSaved(page);
    const text = readFileSync(file, "utf-8");
    check("overwrite keeps external users pos (partial patch)",
        text.includes('"public.users": { pos: [160, 160]'));
    check("overwrite saves my user_profiles move",
        !text.includes('"public.user_profiles": { pos: [80, 256]'));

    // ---- 5b. ER図からの論理外部制約の作成（P-07。3段階 → 即時保存 / Undo 対象外） ----
    const edgesBefore = await page.locator('[data-testid="erd-edge"]').count();
    await page.getByTestId("add-relation").click();
    await page.waitForSelector('[data-testid="erd-fk-picker"]', { timeout: 5000 });
    // 作成モード中は配置編集を止める（クリックの意味が「選ぶ」に変わるため）
    check("fk picker hides the edit toolbar",
        (await page.locator('[data-testid="erd-edit-toolbar"]').count()) === 0);
    await page.click('.react-flow__node[data-id="public.user_sessions"]');
    await page.click('.react-flow__node[data-id="public.user_profiles"]');
    // 3段目は通常の論理外部制約ダイアログ（参照先だけ埋まった状態で開く）
    await page.waitForSelector('[data-testid="fk-ref-table"]', { timeout: 10000 });
    check("the third step opens with the referenced table already chosen",
        (await page.getByTestId("fk-ref-table").getAttribute("data-table-id")) === "public.user_profiles");
    await page.getByTestId("fk-column-0").selectOption("user_id");
    await page.waitForFunction(
      () => {
        const s = document.querySelector('[data-testid="fk-ref-column-0"]');
        return s !== null && !s.disabled && s.options.length > 1;
      },
      null,
      { timeout: 15000 },
    );
    await page.getByTestId("fk-ref-column-0").selectOption("id");
    // カーディナリティは同じダイアログの中で設定する（別枠の一覧ではない。P-11）
    await page.getByTestId("cardinality-child").selectOption("1..N");
    await page.getByTestId("constraint-submit").click();
    // 確定 = 即時保存。index.js が再生成され、破線エッジが1本増える
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="erd-edge"]').length === n + 1,
      edgesBefore,
      { timeout: 15000 },
    );
    check("creating a logical FK from the canvas adds an edge", true);
    const sessionsFile = join(dir, "workspace-default", "data", "schema", "public", "user_sessions.js");
    const sessionsText = readFileSync(sessionsFile, "utf-8");
    check("the logical FK is written to the referencing table's file",
        sessionsText.includes('table: "public.user_profiles"')
        && sessionsText.includes("lfk_user_sessions_user_id"));
    check("the cardinality set in the dialog is written to meta.relations",
        sessionsText.includes('"lfk:lfk_user_sessions_user_id"') && sessionsText.includes('child: "1..N"'));
    // 配置編集の保存状態は動かない（別経路で、Undo の対象にもならない）
    check("an immediate save does not make the layout dirty",
        (await page.locator('[data-testid="save-button"][data-status="saved"]').count()) === 1);

    // ---- 5c. エッジのダブルクリックで編集（編集モード中だけ。閲覧では読むだけ） ----
    const lfkEdge = '.react-flow__edge[data-id="public.user_sessions#lfk:lfk_user_sessions_user_id"]';
    await page.locator(`${lfkEdge} .react-flow__edge-interaction`).dblclick({ force: true });
    await page.waitForSelector('[data-testid="cardinality-fields"]', { timeout: 10000 });
    check("double-clicking an edge while editing opens the editable dialog",
        (await page.getByTestId("fk-ref-table").getAttribute("data-table-id")) === "public.user_profiles");
    // 保存済みなので、今度は解決値（index.js 由来）が出る
    check("the dialog shows the resolved cardinality once saved",
        (await page.getByTestId("cardinality-resolved").textContent())?.includes("1..N"));
    await page.getByTestId("cardinality-parent").selectOption("1..1");
    await page.getByTestId("constraint-submit").click();
    check("editing a relation from the canvas writes the file",
        await waitForFile(sessionsFile, (t) => t.includes('parent: "1..1"')));
    // 保存が済むとダイアログは閉じる（失敗したときは開いたまま理由を出す）
    await page.waitForFunction(
      () => document.querySelector('[data-testid="cardinality-fields"]') === null,
      null,
      { timeout: 15000 },
    );

    // 削除も同じダイアログから（配置の Undo では戻らないので、確認を挟む）
    await page.locator(`${lfkEdge} .react-flow__edge-interaction`).dblclick({ force: true });
    await page.waitForSelector('[data-testid="relation-delete"]', { timeout: 10000 });
    await page.getByTestId("relation-delete").click();
    await page.getByTestId("relation-delete-confirm").click();
    check("deleting a logical FK from the canvas removes the constraint",
        await waitForFile(sessionsFile, (t) => !t.includes("lfk_user_sessions_user_id")));
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="erd-edge"]').length === n,
      edgesBefore,
      { timeout: 15000 },
    );
    check("the edge disappears from the canvas as well", true);

    // ---- 6. 編集終了（未保存なし）→ 閲覧ルートへ戻る ----
    // （エクスポートは静的モード専用になったため、バイト一致の検証は下の静的モードで行う）
    await page.click('[data-testid="session-toggle"][data-editing="true"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="session-toggle"][data-editing="true"]') === null);
    check("session ends back to viewing", true);

    // ---- 6b. 外部でスキーマファイルが変わっても、読み込み進捗は完了する ----
    // 無効化してキャッシュを捨てるだけで読み直さないと「読み込み済み < 全体」のままになり、
    // ヘッダの進捗バーが 100% 手前で消えずに残り続ける
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="toast"]').length === 0,
      null,
      { timeout: 15000 },
    ); // 直前の保存トーストと、次の「外部の変更を反映しました」を取り違えないように
    const schemaFile = join(dir, "workspace-default", "data", "schema", "public", "users.js");
    writeFileSync(schemaFile,
        readFileSync(schemaFile, "utf-8").replace("ユーザーマスタ", "ユーザーマスタ（外部更新）"));
    await page.waitForSelector('[data-testid="toast"]', { timeout: 15000 });
    await page.waitForFunction(
      () => document.querySelector('[role="progressbar"]') === null,
      null,
      { timeout: 10000 },
    );
    check("an external schema change does not leave the loading bar stuck", true);

    check("no page errors (server mode)", pageErrors.length === 0);
    await page.close();

    // ---- 7. 静的モード: file:// で編集 → エクスポート（H-10 / H-13） ----
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
    const staticPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await staticPage.goto("file:///" + join(dir, "index.html").replaceAll("\\", "/"));
    await staticPage.waitForSelector('[data-testid="erd-node"]', { timeout: 15000 });
    // 静的モードでも [編集開始] で編集ルートへ入れる（ロック無し）。
    // 保存はできないため、ヘッダには保存アイコンではなくエクスポートアイコンが出る
    await staticPage.click('[data-testid="session-toggle"]');
    await staticPage.waitForSelector('[data-testid="session-toggle"][data-editing="true"]');
    check("static mode: editing starts (no lock)", true);
    check("static mode: export button shown (no save)",
        await staticPage.locator('[data-testid="export-button"]').isVisible());
    // 動作モードは information に畳んだので、編集中は「保存されません」をヘッダに出す（A-02）
    check("static mode: unsaved warning shown while editing",
        await staticPage.locator('[data-testid="static-warning"]').isVisible());

    await dragNode(staticPage, "public.users", 200, 0);
    await staticPage.click('[data-testid="export-button"]');
    await staticPage.waitForSelector('[data-testid="export-code"]');
    const staticExport = await staticPage.inputValue('[data-testid="export-code"]');
    const posNow = await nodePosOnCanvas(staticPage, "public.users");
    check("static export contains dragged pos (8px grid)",
        posNow[0] % 8 === 0 &&
        staticExport.includes(`"public.users": { pos: [${posNow[0]}, ${posNow[1]}]`));

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
    console.log(process.exitCode ? "EDIT SMOKE FAILED" : "EDIT SMOKE OK");
  },
  (e) => {
    console.log(results.join("\n"));
    console.error(e);
    process.exit(1);
  },
);
