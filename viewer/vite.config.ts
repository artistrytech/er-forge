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

export default defineConfig({
  plugins: [react(), inlineSingleFile()],
  base: "./",
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
});
