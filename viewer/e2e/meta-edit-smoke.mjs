/**
 * テーブル編集・論理名・論理制約のスモークテスト（Phase4 の完了条件の検証）。
 *
 * - サンプルデータを取り込み、テーブル編集画面（O-03）を開く（ロック自動取得）
 * - テーブル論理名を変更し、論理外部制約（P-07）を追加して保存
 *   → schema/**.js に meta が書かれ、index.js が再生成される（P §4.3）
 *   → ER図に破線エッジが1本増える（E-09。Phase4 の完了条件）
 * - カラム論理名の一括編集画面（P-03）で辞書を編集して保存
 *   → dictionary.js が更新される
 *
 * 前提: `npm run build` と `gradlew shadowJar` 済み。実行: `node e2e/meta-edit-smoke.mjs`
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

const results = [];
function check(name, cond) {
  results.push(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond) process.exitCode = 1;
}

/**
 * 制御コンポーネントへの入力は実際のキー入力で行う。
 * locator.fill() は value を直接書き換えるため React の onChange が発火しない。
 */
async function typeInto(locator, text) {
  await locator.click();
  await locator.press("ControlOrMeta+a");
  await locator.pressSequentially(text);
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
  const dir = mkdtempSync(join(tmpdir(), "erd-meta-"));
  copyFileSync(INDEX, join(dir, "index.html"));
  // ワークスペースを1つ用意しておく（サーバーは起動時に workspace-* を走査して認識する）
  mkdirSync(join(dir, "workspace-default", "data"), { recursive: true });

  const proc = spawn(javaBin(), ["-jar", JAR], {
    cwd: dir,
    env: { ...process.env, ERD_NO_BROWSER: "1", ERD_PORT: "5391" },
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

    // サンプルデータの取り込み（A-08）。UI を経ずに API で初期化する
    const token = new URL(url).searchParams.get("t");
    const origin = new URL(url).origin;
    const boot = await fetch(`${origin}/__erd/w/default/bootstrap?t=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "sample" }),
    });
    check("sample bootstrap succeeds", boot.status === 200);

    const page = await browser.newPage();

    // ---- ベースライン: users ページの破線エッジ数 ----
    await page.goto(`${url}#/w/default/erd/users`);
    await page.waitForSelector(".react-flow__node", { timeout: 15000 });
    const logicalBefore = await page.locator('[data-testid="erd-edge"][data-kind="logical"]').count();

    // ---- 403（§8.5）: トークンが違うとデータ配信ごと拒まれる ----
    // データファイルは <script> で読むため、無認証で配ると任意の Web ページから読み出せる。
    // 拒む以上は「データが無い」ではなく、次の手順（起動 URL を開き直す等）を出す
    await page.goto(`${origin}/?t=bogus#/w/default/tables/public.user_sessions/edit`);
    await page.waitForSelector('[data-testid="forbidden"]', { timeout: 15000 });
    check("a token mismatch shows the actionable 403 notice instead of the welcome screen", true);
    const bogusData = await fetch(`${origin}/workspace-default/data/index.js`);
    check("data files are not served without the token", bogusData.status === 403);

    // ---- テーブル編集画面（O-03）: 論理名 + 論理外部制約を保存 ----
    await page.goto(`${url}#/w/default/tables/public.user_sessions/edit`);
    await page.waitForFunction(
      () => {
        const f = document.querySelector("fieldset.edit-form");
        return f !== null && !f.disabled;
      },
      null,
      { timeout: 15000 },
    );
    check("edit form is enabled on the edit route (no lock)", true);

    // 編集中は他画面へのナビを非活性にし（踏むと編集が終わってしまうため）、左パネルも畳む
    check("table edit disables the other nav links",
        (await page.locator('nav [data-disabled="true"]').count()) === 3);
    check("table edit hides the left panel",
        (await page.locator('[data-testid="panel-slot"]:not([data-hidden])').count()) === 0);

    await typeInto(page.locator(".form-grid input").first(), "セッション");

    // 論理外部制約はダイアログで作る（カラムの対応は1行 = 1組の縦並び）
    await page.getByTestId("add-logical-fk").click();
    await page.waitForSelector('[data-testid="fk-ref-filter"]', { timeout: 5000 });
    // 参照先・対応が揃うまでは確定させない（保存時に初めて怒られない）
    check("the constraint dialog blocks submit until it is complete",
        await page.getByTestId("constraint-submit").isDisabled());
    // 候補は入力欄にフォーカスしている間だけ浮かせて出す（ダイアログを塞がない）
    check("the candidate list stays closed until the filter is focused",
        (await page.getByTestId("fk-ref-list").count()) === 0);
    // 参照先は名称（論理名・物理名）で絞り込める
    await page.getByTestId("fk-ref-filter").click();
    await page.waitForSelector('[data-testid="fk-ref-list"]', { timeout: 5000 });
    const allTables = await page.getByTestId("fk-ref-option").count();
    await page.getByTestId("fk-ref-filter").pressSequentially("プロファ");
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="fk-ref-option"]').length === 1,
      null,
      { timeout: 5000 },
    );
    check("the referenced table can be filtered by name", allTables > 1);
    // 絞り込んだ候補は、一覧をクリックした時点で確定する
    await page.locator('[data-testid="fk-ref-option"][data-table-id="public.user_profiles"]').click();
    // 確定したら入力不可の表示に変わり、候補一覧は出さない（うっかり変わらないように）
    await page.waitForSelector('[data-testid="fk-ref-table"]', { timeout: 5000 });
    check("confirming the referenced table hides the candidate list",
        (await page.getByTestId("fk-ref-list").count()) === 0
        && (await page.getByTestId("fk-ref-table").getAttribute("readonly")) !== null);
    await page.getByTestId("fk-column-0").selectOption("user_id");
    // 参照先テーブルのスキーマは選択後に読み込まれる（読み込み完了まで選択肢は出ない）
    await page.waitForFunction(
      () => {
        const s = document.querySelector('[data-testid="fk-ref-column-0"]');
        return s !== null && !s.disabled && s.options.length > 1;
      },
      null,
      { timeout: 15000 },
    );
    await page.getByTestId("fk-ref-column-0").selectOption("id");
    await page.getByTestId("constraint-submit").click();
    check("the constraint is listed after the dialog is confirmed",
        (await page.getByTestId("logical-fk").count()) === 1);
    // 複合キーは行が増える = 対応が縦に並ぶ。開き直しても対応が保たれることを確かめる
    await page.getByTestId("logical-fk-edit").click();
    await page.waitForSelector('[data-testid="fk-ref-table"]', { timeout: 5000 });
    check("reopening the dialog restores the column mapping",
        (await page.getByTestId("fk-column-0").inputValue()) === "user_id"
        && (await page.getByTestId("fk-ref-column-0").inputValue()) === "id");
    await page.getByTestId("add-pair-row").click();
    // 行が増えるだけで対応の読み方は変わらない。片側だけ埋まった状態は確定させない
    check("adding a pair grows the mapping vertically",
        (await page.getByTestId("fk-column-1").count()) === 1
        && (await page.getByTestId("constraint-submit").isDisabled()));
    // [×] で確定を解除すると、絞り込みと候補一覧に戻る（選び直せる）
    await page.getByTestId("fk-ref-clear").click();
    await page.waitForSelector('[data-testid="fk-ref-list"]', { timeout: 5000 });
    check("clearing the referenced table brings the picker back",
        (await page.getByTestId("fk-ref-table").count()) === 0
        && (await page.getByTestId("fk-ref-column-0").isDisabled()));
    // 増やした対応は使わないので、確定せずに閉じる（1組のままにする）
    await page.keyboard.press("Escape");
    check("closing the dialog keeps the previous mapping",
        (await page.getByTestId("logical-fk").count()) === 1);

    // 保存はヘッダの保存アイコンから（変更があると活性化する）。保存後も編集は継続する
    await page.waitForSelector('[data-testid="save-button"]:not([disabled])', { timeout: 15000 });
    await page.getByTestId("save-button").click();
    // 保存が済むと未保存フラグが落ち、保存アイコンが saved（非活性）に戻る
    await page.waitForSelector('[data-testid="save-button"][data-status="saved"]', { timeout: 15000 });
    const stillEditing = (await page.evaluate(() => location.hash)) === "#/w/default/tables/public.user_sessions/edit";
    check("save persists and stays in edit mode", stillEditing);

    const schemaText = readFileSync(
      join(dir, "workspace-default", "data", "schema", "public", "user_sessions.js"),
      "utf-8",
    );
    check("schema file contains the new displayName", schemaText.includes('displayName: "セッション"'));
    check(
      "schema file contains the auto-named logical FK",
      schemaText.includes("lfk_user_sessions_user_id") &&
        schemaText.includes('table: "public.user_profiles"'),
    );

    const indexText = readFileSync(join(dir, "workspace-default", "data", "index.js"), "utf-8");
    check(
      "index.js is regenerated with the lfk edge (P §4.3)",
      indexText.includes("public.user_sessions#lfk:lfk_user_sessions_user_id"),
    );

    // ---- カーディナリティ（P-11）: 別枠の一覧ではなく、各制約の詳細ダイアログで設定する ----
    // 物理FK は定義を変えられない（machine-owned）。詳細から多重度と注記だけ設定できる
    check("the physical FK section lists the FK read from the DB",
        (await page.getByTestId("physical-fk").count()) === 1);
    await page.getByTestId("physical-fk-edit").click();
    await page.waitForSelector('[data-testid="cardinality-fields"]', { timeout: 5000 });
    check("the physical FK dialog shows the constraint name read-only",
        (await page.getByTestId("physical-fk-name").textContent())?.includes("user_sessions_user_id_fkey"));
    check("the resolved cardinality comes from the saved index.js",
        (await page.getByTestId("cardinality-resolved").textContent())?.includes("0..N"));
    await page.getByTestId("cardinality-child").selectOption("1..N");
    // 注記は複数行で書ける（textarea）。改行を含めて保存できることまで確かめる
    await typeInto(page.getByTestId("cardinality-notes"), "セッションは必ず1件以上\n（ログイン時に必ず1件作る）");
    await page.getByTestId("constraint-submit").click();
    check("the row shows a badge once the cardinality is set explicitly",
        (await page.getByTestId("cardinality-badge").count()) >= 1);

    // 論理外部制約の多重度は、同じダイアログの中（制約の属性として）設定する
    await page.getByTestId("logical-fk-edit").click();
    await page.waitForSelector('[data-testid="cardinality-fields"]', { timeout: 5000 });
    await page.getByTestId("cardinality-parent").selectOption("1..1");
    await page.getByTestId("constraint-submit").click();

    await page.waitForSelector('[data-testid="save-button"]:not([disabled])', { timeout: 15000 });
    await page.getByTestId("save-button").click();
    await page.waitForSelector('[data-testid="save-button"][data-status="saved"]', { timeout: 15000 });
    const cardText = readFileSync(
      join(dir, "workspace-default", "data", "schema", "public", "user_sessions.js"),
      "utf-8",
    );
    check("the physical FK cardinality is keyed by fk:<name>",
        cardText.includes('"fk:user_sessions_user_id_fkey"') && cardText.includes('child: "1..N"'));
    check("the logical FK cardinality is keyed by lfk:<name>",
        cardText.includes('"lfk:lfk_user_sessions_user_id"') && cardText.includes('parent: "1..1"'));
    // 改行は \n として書き出される（生の改行を書くと .js が壊れる）
    check("a multi-line note is written with escaped newlines",
        cardText.includes('notes: "セッションは必ず1件以上\\n（ログイン時に必ず1件作る）"'));

    // ---- タグ（P-12）と色（P-13）: 空白で確定、色はタグとは独立に指定する ----
    const tagInput = page.getByTestId("table-tags");
    // サンプルの user_sessions には既に "auth" が付いている（chip 1件が初期状態）
    const chipCount = () => page.getByTestId("tag-chip").count();
    check("existing tags are shown as chips", (await chipCount()) === 1);

    await tagInput.click();
    // 半角スペースで "core" が確定し、"廃止" は未確定のまま入力欄に残る
    await tagInput.pressSequentially("core 廃止");
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="tag-chip"]').length === 2,
      null,
      { timeout: 5000 },
    );
    check("a space confirms the tag as a chip", true);

    // 色を選ぶ操作でタグ入力から抜ける → 未確定の "廃止" は暗黙確定される。
    // 色はトリガーを押してポップアップから選ぶ（候補は body 直下に出る）
    await page.getByTestId("table-color-trigger").click();
    await page.getByTestId("color-muted").click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="tag-chip"]').length === 3,
      null,
      { timeout: 5000 },
    );
    check("the pending text is committed on blur", true);

    await page.waitForSelector('[data-testid="save-button"]:not([disabled])', { timeout: 15000 });
    await page.getByTestId("save-button").click();
    await page.waitForSelector('[data-testid="save-button"][data-status="saved"]', { timeout: 15000 });

    const taggedText = readFileSync(
      join(dir, "workspace-default", "data", "schema", "public", "user_sessions.js"),
      "utf-8",
    );
    check("tags and color are saved independently", taggedText.includes('tags: ["auth", "core", "廃止"]')
      && taggedText.includes('color: "muted"'));
    const indexAfterColor = readFileSync(join(dir, "workspace-default", "data", "index.js"), "utf-8");
    const sessionsEntry = indexAfterColor
      .split("\n")
      .find((line) => line.includes('id: "public.user_sessions"'));
    check(
      "index.js carries the color (the canvas draws nodes from index.js alone)",
      sessionsEntry !== undefined && sessionsEntry.includes('color: "muted"'),
    );
    check("index.js lists the tags in use (autocomplete source)", indexAfterColor.includes("tagsUsed:"));

    // ---- ER図に破線エッジが増える（Phase4 の完了条件） ----
    await page.goto(`${url}#/w/default/erd/users`);
    await page.waitForSelector(".react-flow__node", { timeout: 15000 });
    await page.waitForFunction(
      (before) => document.querySelectorAll('[data-testid="erd-edge"][data-kind="logical"]').length === before + 1,
      logicalBefore,
      { timeout: 15000 },
    );
    check("a dashed edge appears on the diagram", true);

    // 指定色はノードに反映される（D-03）。左パネルの行も同じ色になる
    const coloredNodes = await page.locator('[data-testid="erd-node"][data-color="muted"]').count();
    check("the node is painted with the specified color", coloredNodes === 1);
    const coloredRows = await page.locator('[data-testid="lp-item"][data-color="muted"]').count();
    check("the table list row uses the same color as the node", coloredRows >= 1);

    // ---- カラム辞書（P-03） ----
    // 閲覧は #/columns、編集は #/columns/edit（ロックは無い。P-03 §2.4）
    await page.goto(`${url}#/w/default/columns/edit`);
    await page.waitForSelector('[data-testid="save-button"]', { timeout: 15000 });
    check("column edit disables the other nav links",
        (await page.locator('nav [data-disabled="true"]').count()) === 3);
    // 一覧は仮想化されている（見えている行しか DOM に無い）。目的の行は絞り込みで出す
    await page.waitForSelector('[data-testid="columns-row"]', { timeout: 15000 });
    const rendered = await page.locator('[data-testid="columns-row"]').count();
    const rowCount = await page
      .locator(".columns-page .muted")
      .first()
      .textContent();
    check(
      "the list is virtualized (fewer rows in the DOM than in the dictionary)",
      rendered < Number.parseInt(rowCount ?? "0", 10),
    );
    // 行高が仮想化の前提（ROW_HEIGHT = 44px）と一致していること。ここがずれると
    // スクロール位置と描画がじわじわ食い違う
    const heights = await page
      .locator('[data-testid="columns-row"]')
      .evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
    check("every row matches the fixed row height", heights.every((h) => h === 44));

    await typeInto(page.locator(".catalog-filter"), "session_token");
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="columns-row"]').length === 1,
      null,
      { timeout: 5000 },
    );

    // 論理名・タグ・色をすべて行内で編集する（P-03）
    await typeInto(page.getByTestId("display-name-session_token"), "セッショントークン");
    await typeInto(page.getByTestId("tags-session_token"), "認証 ");
    await page.getByTestId("color-cell-session_token-trigger").click();
    await page.getByTestId("color-blue").click();

    // 保存はヘッダの保存アイコン。全テーブルのロード完了で活性化するまで待ってから押す
    await page.waitForSelector('[data-testid="save-button"]:not([disabled])', { timeout: 20000 });
    await page.getByTestId("save-button").click();
    // 保存が済むと dirty マークが消える（辞書は index.js を再生成しない。P §4.3）
    await page.waitForFunction(
      () => document.querySelectorAll(".columns-table .row-dirty").length === 0,
      null,
      { timeout: 15000 },
    );
    const dictText = readFileSync(join(dir, "workspace-default", "data", "dictionary.js"), "utf-8");
    check("dictionary.js is updated by bulk edit", dictText.includes("セッショントークン"));
    check(
      "the shared tag and color are saved into the dictionary entry",
      /session_token: \{ displayName: "セッショントークン", tags: \["認証"\], color: "blue" \}/.test(
        dictText,
      ),
    );

    // 🔍 は内訳（出現テーブル・個別設定）を見るためのもの。編集中はテーブルへ遷移させない
    await page.getByTestId("detail-session_token").click();
    await page.waitForSelector('[data-testid="detail-occurrences"]', { timeout: 15000 });
    check(
      "the detail dialog lists the tables holding the column",
      (await page.locator('[data-testid="detail-occurrences"] li').count()) >= 1,
    );
    check(
      "table links are inert while editing",
      (await page.locator('[data-testid="detail-occurrences"] a').count()) === 0,
    );
    await page.keyboard.press("Escape");

    // 共通タグ・共通色はテーブル詳細のカラム行に出る（出どころは区別しない。P-12 / P-13）
    await page.goto(`${url}#/w/default/tables/public.user_sessions`);
    await page.waitForSelector(".data-table tbody tr", { timeout: 15000 });
    const sharedTagRow = page.locator("tr", {
      has: page.locator("td", { hasText: "session_token" }),
    });
    check(
      "the table detail shows the shared tag on the column row",
      (await sharedTagRow.getByText("認証").count()) > 0,
    );
    check(
      "the shared color paints the column row",
      (await page.locator('tr[data-color="blue"]').count()) > 0,
    );

    // ---- テーブルの削除（J-02）: 詳細画面の最下部から ----
    const nodesBefore = await (async () => {
      await page.goto(`${url}#/w/default/erd/users`);
      await page.waitForSelector(".react-flow__node", { timeout: 15000 });
      return page.locator('[data-testid="erd-node"]').count();
    })();

    await page.goto(`${url}#/w/default/tables/public.user_sessions`);
    // 詳細は左パネルの範囲を連続表示するので、削除は上部のバー（読んでいる位置のテーブル）から
    const delOf = (id) =>
      page.locator(`[data-testid="doc-active-table"][data-table-id="${id}"] [data-testid="delete-table"]`);
    await delOf("public.user_sessions").waitFor({ timeout: 15000 });
    await delOf("public.user_sessions").click();
    // 削除の前に影響を提示する（§6.2）: 配置ページと、失われる meta
    await page.waitForSelector('[data-testid="delete-impact"]', { timeout: 5000 });
    // 配置ページ・失われる meta・消えるファイルの3行（文言は言語設定に依存するので件数で見る）
    check("the confirmation lists the impact before deleting",
        (await page.locator('[data-testid="delete-impact"] li').count()) === 3);
    check("the confirmation names the schema file that will be deleted",
        ((await page.getByTestId("delete-impact").textContent()) ?? "")
          .includes("schema/public/user_sessions.js"));

    // 配置されているノードも消すかは選べる（既定は消す）
    check("removing the diagram nodes is opt-out (checked by default)",
        await page.getByTestId("delete-remove-nodes").isChecked());

    // baseHash を取り終えるまで確定させない（見ていない内容のまま消さない。INV-5）
    await page.waitForSelector('[data-testid="delete-table-confirm"]:not([disabled])', { timeout: 15000 });
    await page.getByTestId("delete-table-confirm").click();
    // 削除した詳細に留まると「見つかりません」になるため一覧へ戻す
    // （一覧は常に1件選択なので、残っている別のテーブルに着地する）
    await page.waitForFunction(
      () => location.hash.startsWith("#/w/default/tables")
        && !location.hash.includes("user_sessions"),
      null,
      { timeout: 15000 },
    );
    check("deleting the table leaves the deleted table's page", true);
    check(
      "the schema file is deleted",
      !existsSync(join(dir, "workspace-default", "data", "schema", "public", "user_sessions.js")),
    );
    const manifestAfter = readFileSync(join(dir, "workspace-default", "data", "manifest.js"), "utf-8");
    check("manifest.js no longer lists the table",
        !manifestAfter.includes("public.user_sessions"));
    const indexAfterDelete = readFileSync(join(dir, "workspace-default", "data", "index.js"), "utf-8");
    check("index.js no longer carries the table entry",
        !indexAfterDelete.includes('id: "public.user_sessions"'));

    const pageAfterDelete = readFileSync(
      join(dir, "workspace-default", "data", "diagrams", "users.js"), "utf-8");
    check("the node is removed from the diagram page file",
        !pageAfterDelete.includes("public.user_sessions"));

    // ノードごと消したので、孤児ノードは残らない（画面も追随している）
    await page.goto(`${url}#/w/default/erd/users`);
    await page.waitForSelector(".react-flow__node", { timeout: 15000 });
    await page.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="erd-node"]').length === expected,
      nodesBefore - 1,
      { timeout: 15000 },
    );
    check("the diagram loses the node as well",
        (await page.locator('[data-testid="erd-node"][data-missing="true"]').count()) === 0);

    // 消したテーブルを「読み込みに失敗した」と言わない。削除直後に（まだ古い manifest を
    // 見ている）バックグラウンドロードが消えたファイルを取りに行くと tableErrors に残り、
    // 画面を移っても消えない赤帯になる（回帰防止）
    await new Promise((r) => setTimeout(r, 2000));
    check("deleting a table does not report it as failed to load",
        (await page.locator(".error-banner").count()) === 0);

    // チェックを外せば従来どおりノードは孤児として残る（K-13 / §6.2）
    await page.goto(`${url}#/w/default/tables/public.user_addresses`);
    await delOf("public.user_addresses").waitFor({ timeout: 15000 });
    await delOf("public.user_addresses").click();
    await page.waitForSelector('[data-testid="delete-impact"]', { timeout: 5000 });
    await page.getByTestId("delete-remove-nodes").uncheck();
    await page.waitForSelector('[data-testid="delete-table-confirm"]:not([disabled])', { timeout: 15000 });
    await page.getByTestId("delete-table-confirm").click();
    await page.waitForFunction(
      () => location.hash.startsWith("#/w/default/tables")
        && !location.hash.includes("user_addresses"),
      null,
      { timeout: 15000 },
    );
    await page.goto(`${url}#/w/default/erd/users`);
    await page.waitForSelector(".react-flow__node", { timeout: 15000 });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="erd-node"][data-missing="true"]').length === 1,
      null,
      { timeout: 15000 },
    );
    check("unchecking keeps the node as an orphan",
        (await page.locator('[data-testid="erd-node"]').count()) === nodesBefore - 1);

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
