/**
 * N-03: Undo / Redo のキー判定。Windows と Mac で一般的な打ち方が違うので、
 * 環境ごとに「効く／効かない」の両方を押さえる。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRedoKey, isUndoKey, redoHint, undoHint } from "../src/lib/shortcut";

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

function platform(ua: string): void {
  vi.stubGlobal("navigator", { userAgent: ua });
}

/** KeyboardEvent の必要な面だけを作る（jsdom を持ち込まないため）。 */
function key(k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) {
  return {
    key: k,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
  } as KeyboardEvent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isUndoKey", () => {
  it("Windows は Ctrl+Z、Mac は Cmd+Z で戻る", () => {
    platform(WINDOWS_UA);
    expect(isUndoKey(key("z", { ctrl: true }))).toBe(true);
    platform(MAC_UA);
    expect(isUndoKey(key("z", { meta: true }))).toBe(true);
  });

  it("Shift 付きは Redo なので Undo にはしない", () => {
    platform(MAC_UA);
    expect(isUndoKey(key("z", { meta: true, shift: true }))).toBe(false);
  });

  it("修飾キー無しの z は素通しする（入力の邪魔をしない）", () => {
    platform(WINDOWS_UA);
    expect(isUndoKey(key("z"))).toBe(false);
  });
});

describe("isRedoKey", () => {
  it("Windows は Ctrl+Y でやり直す", () => {
    platform(WINDOWS_UA);
    expect(isRedoKey(key("y", { ctrl: true }))).toBe(true);
    expect(isRedoKey(key("Y", { ctrl: true }))).toBe(true);
  });

  it("Ctrl/Cmd+Shift+Z は両環境で受け付ける（Mac の標準）", () => {
    platform(MAC_UA);
    expect(isRedoKey(key("z", { meta: true, shift: true }))).toBe(true);
    platform(WINDOWS_UA);
    expect(isRedoKey(key("z", { ctrl: true, shift: true }))).toBe(true);
  });

  it("Mac の Cmd+Y は割り当てない（ブラウザ既定に譲る）", () => {
    platform(MAC_UA);
    expect(isRedoKey(key("y", { meta: true }))).toBe(false);
    expect(isRedoKey(key("y", { ctrl: true }))).toBe(false);
  });

  it("Shift 無しの Z は Undo なので Redo にしない", () => {
    platform(WINDOWS_UA);
    expect(isRedoKey(key("z", { ctrl: true }))).toBe(false);
  });
});

describe("表記", () => {
  it("その環境で一般的な方だけを見せる", () => {
    platform(WINDOWS_UA);
    expect(undoHint()).toBe("Ctrl+Z");
    expect(redoHint()).toBe("Ctrl+Y");
    platform(MAC_UA);
    expect(undoHint()).toBe("⌘Z");
    expect(redoHint()).toBe("⇧⌘Z");
  });
});
