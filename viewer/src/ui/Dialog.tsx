/**
 * ダイアログの共通枠（G-07 / N-08）。
 * Esc / 背景クリック / × ボタンで閉じる。開いたら内部にフォーカスし、閉じたら元へ戻す。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";

interface DialogProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}

export function Dialog({ title, onClose, children, wide }: DialogProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      opener?.focus?.();
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
        className={"dialog" + (wide ? " dialog-wide" : "")}
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
