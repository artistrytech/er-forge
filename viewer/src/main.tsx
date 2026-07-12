import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { boot } from "./model/loader";

// ビルド後はクラシックスクリプトとして <head> で実行される（file:// 対応。§2.3）ため、
// DOM 構築完了を待ってからマウントする。
function mount(): void {
  void boot();
  const rootEl = document.getElementById("root");
  if (rootEl) {
    createRoot(rootEl).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
