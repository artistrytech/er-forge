/**
 * アイコン + ホバーのポップアップ + クリックのダイアログ、の共通機構。
 *
 * 一覧の行に本文をそのまま並べると行の高さがばらつくため、「あること」だけをアイコンで
 * 残し、中身は**マウスを乗せたときに**読ませる。注記（{@link NotePopover}）と、
 * ドキュメントモードのカラム属性（型・キー・NULL 可否。R-04）が同じ機構を使う。
 *
 * ポップアップは ColorSelect と同じく **body 直下に固定配置**する。表のセルの中で絶対配置
 * すると、スクロールコンテナに閉じ込められて切れてしまうため。
 *
 * ネイティブの title 属性は使わない（表示までの待ちが長く、改行も保てない）。代わりに
 * `role="tooltip"` + `aria-describedby` で結び、キーボードのフォーカスでも同じものを出す。
 *
 * **クリックではダイアログを開く**。ポップアップはポインタを乗せている間しか読めず、
 * 長い中身を落ち着いて読む・選んでコピーする用途には向かないため（ホバーの挙動は据え置き）。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { Dialog } from "./Dialog";
import styles from "./InfoPopover.module.scss";

/**
 * ポップアップの幅の上限（px）。中身なりに広がり（カラム属性はキーの行が長い）、これを超えたら折り返す。
 * 実際の幅を測るまでの仮の値にも使うので CSS の max-width と一致させること
 */
const POPOVER_MAX_WIDTH = 520;

/**
 * 離れてから閉じるまでの猶予（ms）。アイコンとポップアップの間には隙間があり、
 * 猶予が無いと**本文を読みにポインタを動かす途中で消える**（長い中身はスクロールさせたい）。
 */
const CLOSE_DELAY = 150;

export interface InfoPopoverProps {
  /** ポップアップとダイアログの中身（同じものを両方に出す） */
  content: ReactNode;
  /** トリガーのアイコン */
  icon: ReactNode;
  /** トリガーの aria-label */
  label: string;
  testId?: string;
  /** クリックで開くダイアログの見出し */
  dialogTitle: ReactNode;
  /** トリガーの追加クラス */
  className?: string;
}

export function InfoPopover({ content, icon, label, testId, dialogTitle, className }: InfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  /** 描いたポップアップの実際の幅（中身なりに広がる）。右端にはみ出さない位置合わせに使う */
  const [popoverWidth, setPopoverWidth] = useState(POPOVER_MAX_WIDTH);
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
  const openInfoDialog = (): void => {
    cancelClose();
    setOpen(false);
    setDialogOpen(true);
  };
  const closeInfoDialog = (): void => {
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
      const w = popoverRef.current?.offsetWidth;
      if (w !== undefined && w > 0) setPopoverWidth(w);
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
   * ダイアログの Esc。テーブル詳細ダイアログの中から開くことがあり、Dialog 同士の
   * Esc は同じ window で待っている（= 素通しすると親まで一緒に閉じる）。捕捉フェーズで
   * 受け止めて、ここで閉じる分だけを処理する
   */
  useEffect(() => {
    if (!dialogOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeInfoDialog();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialogOpen]);

  const popoverStyle = (): React.CSSProperties => {
    if (anchor === null) return { visibility: "hidden" };
    // 下に入りきらないときは上へ出す（表の最終行でも読めるように）
    const below = window.innerHeight - anchor.bottom;
    const openUp = below < 140 && anchor.top > below;
    return {
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - popoverWidth - 8)),
      ...(openUp ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
    };
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx(styles.trigger, className)}
        data-open={open ? "true" : undefined}
        aria-label={label}
        aria-describedby={open ? popoverId : undefined}
        data-testid={testId}
        onPointerEnter={show}
        onPointerLeave={hideSoon}
        onPointerDown={hideOnPress}
        onFocus={showOnFocus}
        onBlur={hideSoon}
        // クリック（＝ポインタが乗り続けないタップも）ではダイアログでじっくり読ませる
        onClick={openInfoDialog}
      >
        {icon}
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
            {content}
          </div>,
          document.body,
        )}
      {dialogOpen &&
        // テーブル詳細ダイアログの中から開くことがある。body 直下に出して、
        // 表のスクロール枠にも先に開いているダイアログにも切られないようにする
        createPortal(
          <Dialog title={dialogTitle} onClose={closeInfoDialog}>
            <div
              className={styles.dialogBody}
              data-testid={testId === undefined ? undefined : `${testId}-dialog`}
            >
              {content}
            </div>
          </Dialog>,
          document.body,
        )}
    </>
  );
}
