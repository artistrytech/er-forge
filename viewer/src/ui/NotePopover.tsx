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
 *
 * **クリックではダイアログを開く**。ポップアップはポインタを乗せている間しか読めず、
 * 長い注記を落ち着いて読む・選んでコピーする用途には向かないため（ホバーの挙動は据え置き）。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/useI18n";
import { Dialog } from "./Dialog";
import styles from "./NotePopover.module.scss";

/** ポップアップの幅（px）。位置合わせに使うので CSS と一致させること */
const POPOVER_WIDTH = 320;

/**
 * 離れてから閉じるまでの猶予（ms）。アイコンとポップアップの間には隙間があり、
 * 猶予が無いと**本文を読みにポインタを動かす途中で消える**（長い注記はスクロールさせたい）。
 */
const CLOSE_DELAY = 150;

export function NotePopover({
  text,
  testId,
  dialogTitle,
}: {
  text: string;
  testId?: string;
  /** クリックで開くダイアログの見出し（既定は「注記」） */
  dialogTitle?: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const closeTimer = useRef<number | null>(null);
  const popoverId = useId();
  /**
   * ダイアログを閉じると Dialog がフォーカスをこのボタンへ戻す。そのフォーカスで
   * ポップアップまで開くと「閉じたのに出てくる」ので、戻ってきた1回だけ見送る。
   * ポインタで入り直した場合は普通にホバーなので、そちらは止めない
   */
  const skipFocusShow = useRef(false);

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
  /** フォーカスで開く方。ダイアログを閉じた直後の「戻ってきたフォーカス」だけは見送る */
  const showOnFocus = (): void => {
    if (skipFocusShow.current) {
      skipFocusShow.current = false;
      cancelClose();
      return;
    }
    show();
  };
  /** 猶予つきで閉じる。アイコン → ポップアップへポインタを移す間に消えないように */
  const hideSoon = (): void => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, CLOSE_DELAY);
  };
  /**
   * 押した時点でポップアップを引っ込める。click は**離したとき**に来るので、押しっぱなしの
   * 間ポップアップが出たままになり、そのままダイアログに重なって見える（ポップアップの方が
   * 手前に出るため）。押下で入るフォーカスで開き直さないよう、そちらも見送る
   */
  const hideOnPress = (): void => {
    cancelClose();
    setOpen(false);
    skipFocusShow.current = true;
  };
  /** クリックで開く方。キーボード（Enter / Space）はここだけを通る */
  const openNoteDialog = (): void => {
    cancelClose();
    setOpen(false);
    setDialogOpen(true);
  };
  const closeNoteDialog = (): void => {
    skipFocusShow.current = true;
    setDialogOpen(false);
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

  /**
   * 注記ダイアログの Esc。テーブル詳細ダイアログの中から開くことがあり、Dialog 同士の
   * Esc は同じ window で待っている（= 素通しすると親まで一緒に閉じる）。捕捉フェーズで
   * 受け止めて、ここで閉じる分だけを処理する
   */
  useEffect(() => {
    if (!dialogOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeNoteDialog();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialogOpen]);

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
        onPointerDown={hideOnPress}
        onFocus={showOnFocus}
        onBlur={hideSoon}
        // クリック（＝ポインタが乗り続けないタップも）ではダイアログでじっくり読ませる
        onClick={openNoteDialog}
      >
        <NoteIcon />
      </button>
      {/* ポップアップはダイアログより手前の層に出る。ダイアログ表示中は絶対に出さない */}
      {open &&
        !dialogOpen &&
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
      {dialogOpen &&
        // テーブル詳細ダイアログの中から開くことがある。body 直下に出して、
        // 表のスクロール枠にも先に開いているダイアログにも切られないようにする
        createPortal(
          <Dialog title={dialogTitle ?? t("table.colNotes")} onClose={closeNoteDialog}>
            <div
              className={styles.dialogText}
              data-testid={testId === undefined ? undefined : `${testId}-dialog`}
            >
              {text}
            </div>
          </Dialog>,
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
