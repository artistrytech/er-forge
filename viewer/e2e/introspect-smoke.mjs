/**
 * 逆生成のスモークテスト（Phase5 の完了条件の検証）。
 *
 * - 空プロジェクトで起動 → ブートストラップの「既存のスキーマから生成する」（§3.6）
 * - drivers/*.jar に置いた H2 ドライバが DriverShim 経由で登録される（§7.2 / K-01）
 * - 接続テスト（K-04）→ 逆生成（K-07）→ 差分プレビュー（K-08）→ 適用（K-11）
 *   → data/schema/** が生成され、コメントから論理名が補完される（K-14）
 * - 人が meta（論理名・注記）を書き、ER図にノードを置いた状態で DB を変更して再実行
 *   → 2回目のプレビューで「カラム追加」だけが出る（T-1: 誤差分ゼロ）
 *   → 適用しても meta と diagrams が保持される（INV-1 / INV-2。Phase5 の完了条件）
 *
 * 前提: `npm run build` と `gradlew shadowJar` 済み。実行: `node e2e/introspect-smoke.mjs`
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/** テスト用の JDBC ドライバ（H2）を Gradle のキャッシュから探す */
function findH2Jar() {
  const base = join(homedir(), ".gradle", "caches", "modules-2", "files-2.1", "com.h2database", "h2");
  if (!existsSync(base)) return null;
  for (const version of readdirSync(base)) {
    const versionDir = join(base, version);
    for (const hash of readdirSync(versionDir)) {
      const dir = join(versionDir, hash);
      for (const file of readdirSync(dir)) {
        if (file.endsWith(".jar") && !file.includes("sources")) return join(dir, file);
      }
    }
  }
  return null;
}

const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS "public";
CREATE TABLE IF NOT EXISTS "public"."users" (
  "id" BIGINT AUTO_INCREMENT PRIMARY KEY,
  "email" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "public"."users"("email");
COMMENT ON TABLE "public"."users" IS 'ユーザーマスタ';
CREATE TABLE IF NOT EXISTS "public"."orders" (
  "id" BIGINT AUTO_INCREMENT PRIMARY KEY,
  "user_id" BIGINT NOT NULL,
  CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
);
COMMENT ON TABLE "public"."orders" IS '注文';
`;

/** 2回目の内省で「カラム追加」を1件だけ出すための DDL */
const ALTER_SQL = `
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "nickname" VARCHAR(64);
`;

async function main() {
  if (!existsSync(JAR) || !existsSync(INDEX)) {
    console.error("erd-server.jar / dist/index.html がありません。先にビルドしてください。");
    process.exit(1);
  }
  const h2 = findH2Jar();
  if (h2 === null) {
    console.error("H2 の jar が見つかりません（先に server のテストを1回実行してください）。");
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), "erd-intro-"));
  copyFileSync(INDEX, join(dir, "index.html"));
  mkdirSync(join(dir, "drivers"));
  copyFileSync(h2, join(dir, "drivers", "h2.jar"));
  writeFileSync(join(dir, "schema.sql"), SCHEMA_SQL, "utf-8");
  writeFileSync(join(dir, "alter.sql"), ALTER_SQL, "utf-8");

  // H2 のファイル DB。接続のたびに INIT が走るため DDL は冪等にしてある
  const jdbcUrl = "jdbc:h2:./testdb;INIT=RUNSCRIPT FROM './schema.sql'";
  const jdbcUrlAltered = "jdbc:h2:./testdb;INIT=RUNSCRIPT FROM './alter.sql'";

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

    const page = await browser.newPage();

    // ---- ブートストラップ（§3.6）: 「既存のスキーマから生成する」→ 逆生成の画面 ----
    await page.goto(url);
    await page.waitForSelector(".bootstrap-screen", { timeout: 15000 });
    await page.getByRole("link", { name: "既存のスキーマから生成する" }).click();
    await page.waitForSelector('[data-testid="introspect-page"]', { timeout: 15000 });
    check("bootstrap offers introspection for an empty project", true);

    // ---- K-01: drivers/ に置いた H2 が DriverShim 経由で登録されている ----
    await page.waitForFunction(
      () => document.body.textContent.includes("org.h2.Driver"),
      null,
      { timeout: 15000 },
    );
    check("drivers/*.jar is registered via DriverShim (§7.2)", true);

    // ---- K-04: 接続テスト ----
    await page.getByTestId("jdbc-url").click();
    await page.getByTestId("jdbc-url").pressSequentially(jdbcUrl);
    await page.getByTestId("test-connection").click();
    await page.waitForSelector('[data-testid="test-result"]', { timeout: 20000 });
    check("connection test reports the product", true);
    await page.getByTestId("namespace").selectOption("public");

    // ---- K-07 / K-08: 逆生成 → 差分プレビュー（すべて追加） ----
    await page.getByTestId("run-introspect").click();
    await page.waitForSelector('[data-testid="stats"]', { timeout: 30000 });
    const stats = await page.getByTestId("stats").textContent();
    check("preview reports 2 added tables", /追加: 2/.test(stats));

    // プレビューは1バイトも書き込まない（INV-4）
    check("preview writes nothing (INV-4)", !existsSync(join(dir, "data", "manifest.js")));

    // ---- K-11: 適用 → data/** が生成される ----
    await page.getByTestId("apply").click();
    // 空プロジェクトからの初期化はリロードして通常のロード経路に入る
    await page.waitForSelector('.react-flow, .catalog-page, [data-testid="app-main"]', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 500));

    const usersFile = join(dir, "data", "schema", "public", "users.js");
    check("schema files are generated", existsSync(usersFile));
    const usersText = readFileSync(usersFile, "utf-8");
    // K-14: コメントの1行目が論理名の初期値として書かれる
    check("logical name is seeded from the DB comment (K-14)",
      usersText.includes('displayName: "ユーザーマスタ"'));
    check("physical FK is captured",
      readFileSync(join(dir, "data", "schema", "public", "orders.js"), "utf-8")
        .includes('table: "public.users"'));

    // ---- 人が meta と ER図の配置を整備した状態を作る ----
    const token = new URL(url).searchParams.get("t");
    const origin = new URL(url).origin;
    // 編集ロックは無い（H-11 廃止）。baseHash だけで直接書ける（§8.3）
    const table = await (await fetch(`${origin}/__erd/tables/public.users?t=${token}`)).json();
    const put = await fetch(`${origin}/__erd/tables/public.users?t=${token}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseHash: table.baseHash,
        table: {
          id: "public.users",
          name: "users",
          schema: "public",
          comment: "ユーザーマスタ",
          columns: [
            { name: "id", type: "bigint", logicalType: "int", nullable: false, autoIncrement: true },
            { name: "email", type: "character varying(255)", logicalType: "string", nullable: false },
            { name: "created_at", type: "timestamp", logicalType: "datetime", nullable: false,
              default: "current_timestamp" },
          ],
          primaryKey: ["id"],
          uniques: [{ name: "users_email_key", columns: ["email"] }],
          meta: {
            displayName: "ユーザー",
            notes: "論理削除は deleted_at 運用",
            columns: { email: { displayName: "メールアドレス" } },
          },
        },
      }),
    });
    check("a person can write meta on the introspected table", put.status === 200);

    // ---- K-12 / I-01: 逆生成の直後は ER図 のページが0件。そこから GUI だけで配置まで進める ----
    // 逆生成は diagrams/** を書かない（INV-2）ため、ページは人が作る。ここに導線が無いと
    // 「DB から生成したが ER図 を描けない」行き止まりになる（設計書 §3.4 の運用フロー）
    const diagramFile = join(dir, "data", "diagrams", "main.js");
    await page.goto(`${url}#/erd`);
    await page.reload();
    await page.waitForSelector('[data-testid="erd-empty"]', { timeout: 15000 });
    check("K-12: the no-pages state offers page creation after introspection", true);

    // ロックは無い。作成後は閲覧ルート（#/erd/main）へ着地する
    await page.getByTestId("create-first-page").click();
    await page.waitForSelector('[data-testid="page-id"]', { timeout: 10000 });
    await page.getByTestId("page-id").pressSequentially("main");
    await page.getByTestId("page-title").pressSequentially("メイン");
    await page.getByTestId("page-create").click();
    await page.waitForFunction(() => location.hash === "#/erd/main", { timeout: 10000 });
    check("I-01: the first page is created from the GUI", existsSync(diagramFile));

    // 配置するには編集ルートへ入る（[編集開始]）
    await page.getByTestId("session-toggle").click();
    await page.waitForSelector('[data-testid="session-toggle"][data-editing="true"]', { timeout: 5000 });

    // 未配置トレイから自動配置（H-08）→ Ctrl+S で保存（自動保存は無い）
    await page.getByTestId("tray-auto-place").click();
    await page.waitForSelector('.react-flow__node[data-id="public.users"]', { timeout: 20000 });
    await page.keyboard.press("Control+s");
    await page.waitForSelector('[data-testid="save-button"][data-status="saved"]', { timeout: 15000 });
    const placed = readFileSync(diagramFile, "utf-8");
    check("K-12 / I-04: unplaced tables are placed onto the new page",
      placed.includes('"public.users"') && placed.includes('"public.orders"'));

    // 編集を終える → 閲覧ルートへ戻る
    await page.getByTestId("session-toggle").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="session-toggle"][data-editing="true"]') === null);
    const diagramsBefore = readFileSync(diagramFile, "utf-8");

    // ---- 2回目: DB にカラムを追加して再実行 ----
    await page.goto(`${url}#/introspect`);
    await page.reload();
    await page.waitForSelector('[data-testid="introspect-page"]', { timeout: 15000 });
    await page.getByTestId("jdbc-url").click();
    await page.getByTestId("jdbc-url").press("ControlOrMeta+a");
    await page.getByTestId("jdbc-url").pressSequentially(jdbcUrlAltered);
    await page.getByTestId("test-connection").click();
    await page.waitForSelector('[data-testid="test-result"]', { timeout: 20000 });
    await page.getByTestId("namespace").selectOption("public");
    await page.getByTestId("run-introspect").click();
    await page.waitForSelector('[data-testid="stats"]', { timeout: 30000 });

    const stats2 = await page.getByTestId("stats").textContent();
    // T-1: 変更は追加カラムの1件だけ。同じ DB の再内省で誤差分が出ない
    check("second preview shows only the modified table (T-1)",
      /追加: 0/.test(stats2) && /変更: 1/.test(stats2) && /削除: 0/.test(stats2));

    await page.getByTestId("apply").click();
    await page.waitForSelector('[data-testid="apply-result"]', { timeout: 30000 });
    check("apply completes", true);

    const usersAfter = readFileSync(usersFile, "utf-8");
    check("the new column is applied", usersAfter.includes('name: "nickname"'));
    // INV-1: 人が書いた meta は1文字も変わらない
    check("meta survives introspection (INV-1)",
      usersAfter.includes('displayName: "ユーザー"') &&
        usersAfter.includes("論理削除は deleted_at 運用") &&
        usersAfter.includes('displayName: "メールアドレス"'));
    // INV-2: diagrams は一切書き換えない
    check("diagrams are untouched (INV-2)",
      readFileSync(diagramFile, "utf-8") === diagramsBefore);

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
