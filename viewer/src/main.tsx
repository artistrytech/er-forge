import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { connectEvents, installUnloadHandlers } from "./model/editStore";
import { boot } from "./model/loader";
import { useAppStore } from "./model/store";

// ビルド後はクラシックスクリプトとして <head> で実行される（file:// 対応。§2.3）ため、
// DOM 構築完了を待ってからマウントする。
function mount(): void {
  void boot();
  installUnloadHandlers();
  // モード判定は非同期（/__erd/health）。サーバーモード確定後に SSE を張る（H-09）
  if (useAppStore.getState().serverMode === true) {
    connectEvents();
  } else {
    const unsub = useAppStore.subscribe((s) => {
      if (s.serverMode === true) {
        connectEvents();
        unsub();
      }
    });
  }
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
