/**
 * 静的モード（file://）で動くための必須設定（設計書 §2.3）。
 * - クラシックスクリプト（iife）のみ。コード分割・動的 import 禁止
 * - 単一 index.html に全アセットをインライン化
 *
 * インライン化は自前プラグインで行う（vite-plugin-singlefile が
 * Vite 7/8 + iife 出力で JS を空のまま埋め込む問題を踏んだため）。
 */
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function inlineSingleFile(): Plugin {
  return {
    name: "erd-inline-single-file",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlAsset = bundle["index.html"];
      if (!htmlAsset || htmlAsset.type !== "asset") return;
      let html = String(htmlAsset.source);

      for (const [name, item] of Object.entries(bundle)) {
        if (name === "index.html") continue;
        if (item.type === "chunk" && name.endsWith(".js")) {
          const tag = new RegExp(
            `<script[^>]*src="[./]*${escapeRegExp(name)}"[^>]*></script>`,
          );
          // クラシックスクリプトとして埋め込む（type="module" は file:// で不安定なため付けない）
          html = html.replace(tag, () => `<script>\n${item.code}\n</script>`);
          delete bundle[name];
        } else if (item.type === "asset" && name.endsWith(".css")) {
          const tag = new RegExp(`<link[^>]*href="[./]*${escapeRegExp(name)}"[^>]*>`);
          html = html.replace(tag, () => `<style>\n${String(item.source)}\n</style>`);
          delete bundle[name];
        }
      }
      htmlAsset.source = html;
    },
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 開発サーバーは2通りある。
 *
 * - `npm run dev`        : ビューア単体。データは `public/data/**`（静的モード相当の固定データ）
 * - `npm run dev:server` : Java サーバー（`gradlew devServer`）と繋ぐ。**サーバーモードで動く**
 *
 * ビューアはデータを常に `<script src="data/**.js">` の相対パスで読む（設計書 §4.3。
 * 読み込み経路はモードによらず1本）。dev:server でも本番とまったく同じ経路を通すため、
 * `/data` と `/__erd` を Java サーバーへプロキシする。`GET /__erd/health` が通ることで、
 * ビューアはサーバーモードとして起動する（A-01）。
 *
 * このとき `public/` を無効化する。有効なままだと `public/data/**`（単体 dev 用の固定データ）が
 * `/data` を先に掴みうるため、**サーバーの実データではなく古い固定データを見て**しまう。
 * どちらのデータを見ているのか分からない状態が一番たちが悪いので、明示的に外す。
 *
 * トークンは Java 側を ERD_TOKEN で固定し、開く URL に埋めておく（§8.1 の `?t=`）。
 */
const BACKEND = `http://127.0.0.1:${process.env.ERD_PORT ?? 5321}`;
const DEV_TOKEN = process.env.ERD_TOKEN ?? "erd-dev";

export default defineConfig(({ mode }) => {
  const withServer = mode === "server";
  return {
    plugins: [react(), inlineSingleFile()],
    base: "./",
    publicDir: withServer ? false : "public",
    server: {
      port: 5173,
      strictPort: true,
      open: withServer ? `/?t=${DEV_TOKEN}` : "/",
      proxy: withServer
        ? {
            // SSE（GET /__erd/events）もそのまま流れる
            "/__erd": { target: BACKEND, changeOrigin: false },
            "/data": { target: BACKEND, changeOrigin: false },
          }
        : undefined,
    },
    build: {
      target: "es2019",
      cssCodeSplit: false,
      assetsInlineLimit: 100000000,
      chunkSizeWarningLimit: 2000,
      modulePreload: false,
      rollupOptions: {
        output: {
          format: "iife",
          inlineDynamicImports: true,
        },
      },
    },
  };
});
