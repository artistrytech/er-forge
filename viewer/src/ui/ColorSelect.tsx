/**
 * 色の選択（P-13）。用意したトークンから選ぶだけで、任意の色は指定できない
 * （理由は model/colors.ts）。色は**タグとは独立**しており、タグを付けなくても色だけ付けられる。
 *
 * 表示は「現在の色の丸1つ」で、押すと候補をポップアップで出す。トークン8個を常時並べると、
 * 一覧の行に置いたときに横幅を食い、ボタン数も行数×8 になって重い（カラム辞書は数百行ある）。
 *
 * ポップアップは TagInput の候補と同じく **body 直下に固定配置**する。表のセルの中で
 * 絶対配置すると、スクロールコンテナに閉じ込められて切れてしまうため。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/useI18n";
import { cx } from "../lib/cx";
import { colorAttr, COLOR_TOKENS, isColorToken, type ColorToken } from "../model/colors";
import styles from "./ColorSelect.module.scss";

interface ColorSelectProps {
  /** "" は未設定 */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  testId?: string;
}

/** 選択肢の並び（先頭が「色なし」）。キーボード移動の順序でもある */
const OPTIONS: ("" | ColorToken)[] = ["", ...COLOR_TOKENS];

export function ColorSelect({ value, onChange, disabled, testId }: ColorSelectProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  // 未知のトークン（手で編集したファイル）はトークン名をそのまま出す
  const labelOf = (token: string): string =>
    token === "" ? t("colorSelect.none") : isColorToken(token) ? t(`color.${token}`) : token;

  // 位置は開いている間だけ測る。スクロール（表の横スクロール・仮想化した縦スクロール）に追随する
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

  // 外側クリック / Esc で閉じる。閉じたらトリガーへフォーカスを戻す
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // ダイアログの中で使われることがあるため、ダイアログまで Esc を伝えない
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // 開いたら選択中の色へフォーカスする（キーボードだけで選べるように）
  useEffect(() => {
    if (!open) return;
    const selected = popoverRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (selected ?? popoverRef.current?.querySelector("button"))?.focus();
  }, [open]);

  const pick = (token: string): void => {
    onChange(token);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onPopoverKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown"
      ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : 0;
    if (step === 0) return;
    e.preventDefault();
    const buttons = [...(popoverRef.current?.querySelectorAll("button") ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(current + step + buttons.length) % buttons.length];
    next?.focus();
  };

  const popoverStyle = (): React.CSSProperties => {
    if (anchor === null) return { visibility: "hidden" };
    const below = window.innerHeight - anchor.bottom;
    const openUp = below < 80 && anchor.top > below;
    return {
      // 右端で切れないように、はみ出す分だけ左へ寄せる
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - 260)),
      ...(openUp ? { bottom: window.innerHeight - anchor.top + 4 } : { top: anchor.bottom + 4 }),
    };
  };

  return (
    <div className={styles.colorSelect} data-testid={testId}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`${t("colorSelect.label")}: ${labelOf(value)}`}
        title={labelOf(value)}
        data-testid={testId === undefined ? undefined : `${testId}-trigger`}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={cx(styles.swatch, value === "" && styles.none)}
          data-color={colorAttr(value)}
        />
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className={styles.popover}
            role="radiogroup"
            aria-label={t("colorSelect.label")}
            data-testid={testId === undefined ? undefined : `${testId}-popover`}
            style={popoverStyle()}
            onKeyDown={onPopoverKeyDown}
          >
            {OPTIONS.map((token) => (
              <button
                key={token === "" ? "none" : token}
                type="button"
                role="radio"
                aria-checked={value === token}
                aria-label={labelOf(token)}
                title={labelOf(token)}
                data-color={colorAttr(token)}
                data-testid={token === "" ? "color-none" : `color-${token}`}
                className={cx(
                  styles.swatch,
                  styles.option,
                  token === "" && styles.none,
                  value === token && styles.selected,
                )}
                onClick={() => pick(token)}
              />
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
