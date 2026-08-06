/**
 * 注記（人が書いた説明）をノートアイコン + ポップアップで見せる（閲覧側）。
 *
 * 一覧の行に本文をそのまま並べると、注記の長さで行の高さがばらつき、カラム一覧が縦に
 * 伸びすぎる。「注記があること」だけを一覧に残し、本文は**マウスを乗せたときに**読ませる。
 *
 * ポップアップは ColorSelect と同じく **body 直下に固定配置**する。表のセルの中で絶対配置
 * すると、スクロールコンテナに閉じ込められて切れてしまうため。
 *
 * ネイティブの title 属性は使わない（表示までの待ちが長く、改行も保てない）。代わりに
 * `role="tooltip"` + `aria-describedby` で結び、キーボードのフォーカスでも同じものを出す。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/useI18n";
import styles from "./NotePopover.module.scss";

/** ポップアップの幅（px）。位置合わせに使うので CSS と一致させること */
const POPOVER_WIDTH = 320;

/**
 * 離れてから閉じるまでの猶予（ms）。アイコンとポップアップの間には隙間があり、
 * 猶予が無いと**本文を読みにポインタを動かす途中で消える**（長い注記はスクロールさせたい）。
 */
const CLOSE_DELAY = 150;

export function NotePopover({ text, testId }: { text: string; testId?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const closeTimer = useRef<number | null>(null);
  const popoverId = useId();

  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const show = (): void => {
    cancelClose();
    setOpen(true);
  };
  /** 猶予つきで閉じる。アイコン → ポップアップへポインタを移す間に消えないように */
  const hideSoon = (): void => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, CLOSE_DELAY);
  };

  // アンマウント（仮想化・ページ遷移）で宙に浮いたタイマーを残さない
  useEffect(() => cancelClose, []);

  // 位置は開いている間だけ測る。表の横スクロール・ページのスクロールに追随する
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const measure = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect !== undefined) setAnchor(rect);
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  // Esc で閉じる（キーボードで開いたときの逃げ道）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // ダイアログの中で使われることがあるため、ダイアログまで Esc を伝えない
      e.stopPropagation();
      cancelClose();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (text === "") return null;

  const popoverStyle = (): React.CSSProperties => {
    if (anchor === null) return { visibility: "hidden" };
    // 下に入りきらないときは上へ出す（表の最終行でも読めるように）
    const below = window.innerHeight - anchor.bottom;
    const openUp = below < 140 && anchor.top > below;
    return {
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - POPOVER_WIDTH - 8)),
      ...(openUp ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
    };
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        data-open={open ? "true" : undefined}
        aria-label={t("table.showNotes")}
        aria-describedby={open ? popoverId : undefined}
        data-testid={testId}
        onPointerEnter={show}
        onPointerLeave={hideSoon}
        onFocus={show}
        onBlur={hideSoon}
        // タップ（ポインタが乗り続けない環境）でも開けるようにする
        onClick={show}
      >
        <NoteIcon />
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            className={styles.popover}
            role="tooltip"
            data-testid={testId === undefined ? undefined : `${testId}-popover`}
            style={popoverStyle()}
            // 本文を読む・スクロールする間は開いたままにする
            onPointerEnter={show}
            onPointerLeave={hideSoon}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

function NoteIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4h13l3 3v13H4z" />
      <line x1="8" y1="9" x2="15" y2="9" />
      <line x1="8" y1="13" x2="15" y2="13" />
      <line x1="8" y1="17" x2="12" y2="17" />
    </svg>
  );
}
