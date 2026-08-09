/**
 * ダイアログの共通枠（G-07 / N-08）。
 * Esc / 背景クリック / × ボタンで閉じる。開いたら内部にフォーカスし、閉じたら元へ戻す。
 *
 * 開いた直後に入力欄へフォーカスしたいときは、その要素に `data-autofocus` を付ける。
 * **React の `autoFocus` は使わない** — あれは DOM 挿入時の1回きりで、開発ビルド
 * （StrictMode）では effect が2度走る間に後始末でフォーカスが外へ戻り、二度と当たらない。
 * ここで effect から focus() すれば、何度走っても同じ要素に落ち着く。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";

interface DialogProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** 既定（560px）/ wide（860px）/ full（画面いっぱいに近い大きさ） */
  size?: "wide" | "full";
}

export function Dialog({ title, onClose, children, size }: DialogProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  /**
   * 開く前にフォーカスしていた要素（閉じたら戻す）。**描画時に捕まえる** —
   * effect まで待つと、中の入力欄が先にフォーカスを取っており、「開いた側」ではなく
   * 閉じると同時に消える入力欄を覚えてしまう（戻し先が無くなる）。
   */
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const target = el.querySelector<HTMLElement>("[data-autofocus]");
    if (target !== null) {
      target.focus();
    } else if (!el.contains(document.activeElement)) {
      // 中で自前にフォーカスを取っている場合（注記の編集など）は尊重する。
      // 無条件に枠へ focus() すると、それを奪って開いてすぐ打てなくなる
      el.focus();
    }
    return () => {
      opener.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={"dialog" + (size === undefined ? "" : ` dialog-${size}`)}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={ref}
      >
        <div className="dialog-header">
          <div className="dialog-title">{title}</div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label={t("dialog.close")}>
            ×
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
