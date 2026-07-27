/**
 * タグ入力（P-12）。確定済みのタグをチップで並べ、末尾の入力欄で追加する。
 *
 * 確定は **空白（半角 / 全角）・Enter・カンマ・Tab・フォーカスアウト**。
 * 日本語入力の変換確定スペースで誤確定しないよう、**IME 変換中（isComposing）は
 * どのキーも処理しない**。ここを踏み外すと「廃止」と打つだけでタグが2つに割れる。
 *
 * 候補は index.js の tagsUsed（全テーブル未ロードでも引ける）＋ 呼び出し側が渡す追加候補。
 * 未確定の文字列は blur 時に暗黙確定する（入力したのに消える事故を防ぐ）。
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/useI18n";
import { cx } from "../lib/cx";
import { MAX_TAGS, normalizeTag, splitTagInput, tagError } from "../model/metaRules";
import styles from "./TagInput.module.scss";

interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** 候補（使用中のタグ）。既に付いているタグは自動で除外する */
  candidates: readonly string[];
  disabled?: boolean;
  /** 一覧の行内など、狭い場所で使うとき */
  compact?: boolean;
  testId?: string;
}

const SUGGEST_LIMIT = 8;

export function TagInput({
  value,
  onChange,
  candidates,
  disabled,
  compact,
  testId,
}: TagInputProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  /** Backspace の1回目で「次に押したら消える」状態にする（いきなり消さない） */
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const suggestions = useMemo(() => {
    const owned = new Set(value.map((v) => v.toLowerCase()));
    const q = normalizeTag(text).toLowerCase();
    const rest = candidates.filter((c) => !owned.has(c.toLowerCase()));
    if (q === "") return rest.slice(0, SUGGEST_LIMIT);
    // 前方一致を先に、その後ろに部分一致（絞り込みの体感に合わせる）
    const prefix = rest.filter((c) => c.toLowerCase().startsWith(q));
    const partial = rest.filter(
      (c) => !c.toLowerCase().startsWith(q) && c.toLowerCase().includes(q),
    );
    return [...prefix, ...partial].slice(0, SUGGEST_LIMIT);
  }, [candidates, value, text]);

  const showSuggestions = focused && suggestions.length > 0;

  // 候補は body 直下に固定配置するため、入力欄の位置を測って渡す。
  // スクロール（カラム表の横スクロール・ページのスクロール）にも追随させる
  useLayoutEffect(() => {
    if (!showSuggestions) {
      setAnchor(null);
      return;
    }
    const measure = (): void => {
      const rect = fieldRef.current?.getBoundingClientRect();
      if (rect !== undefined) setAnchor(rect);
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [showSuggestions, suggestions.length]);

  /** 下に入りきらないときは上に出す（画面外に垂れ流さない） */
  const listStyle = (): React.CSSProperties => {
    if (anchor === null) return { visibility: "hidden" };
    const below = window.innerHeight - anchor.bottom;
    const openUp = below < 240 && anchor.top > below;
    return {
      left: anchor.left,
      width: Math.max(anchor.width, 160),
      ...(openUp
        ? { bottom: window.innerHeight - anchor.top + 2 }
        : { top: anchor.bottom + 2, maxHeight: Math.max(120, below - 12) }),
    };
  };

  const add = (raw: string): void => {
    const tags = splitTagInput(raw);
    if (tags.length === 0) {
      setText("");
      return;
    }
    const next = [...value];
    for (const tag of tags) {
      if (next.length >= MAX_TAGS) {
        setError(t("tagInput.tooMany", { n: MAX_TAGS }));
        break;
      }
      const code = tagError(tag, next);
      if (code === "TAG_TOO_LONG") {
        setError(t("tagInput.tooLong", { n: 32 }));
        continue;
      }
      if (code === "TAG_DUPLICATE") continue; // 既にあるものは黙って捨てる
      next.push(tag);
      setError(null);
    }
    setText("");
    setActive(-1);
    if (next.length !== value.length) onChange(next);
  };

  const remove = (tag: string): void => {
    onChange(value.filter((x) => x !== tag));
    setError(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // IME 変換中は素通し（変換確定のスペース・Enter でタグを切らない）
    if (e.nativeEvent.isComposing) return;

    if (e.key === "ArrowDown" && showSuggestions) {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
      return;
    }
    if (e.key === "ArrowUp" && showSuggestions) {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
      return;
    }
    if (e.key === "Escape") {
      setActive(-1);
      setFocused(false);
      return;
    }
    if (e.key === " " || e.key === "　" || e.key === "," || e.key === "、" || e.key === "Enter") {
      e.preventDefault();
      const picked = active >= 0 ? suggestions[active] : undefined;
      add(picked ?? text);
      return;
    }
    if (e.key === "Tab") {
      // フォーカス移動は妨げない。入力中の文字列だけ確定させる
      if (normalizeTag(text) !== "") add(text);
      return;
    }
    if (e.key === "Backspace" && text === "" && value.length > 0) {
      e.preventDefault();
      if (armed) {
        remove(value[value.length - 1]!);
        setArmed(false);
      } else {
        setArmed(true);
      }
      return;
    }
    setArmed(false);
  };

  return (
    <div className={cx(styles.tagInput, compact && styles.compact, disabled && styles.disabled)}>
      <div
        ref={fieldRef}
        className={styles.field}
        onMouseDown={(e) => {
          // チップの隙間を押しても入力欄にフォーカスする
          if (e.target === e.currentTarget) inputRef.current?.focus();
        }}
      >
        {value.map((tag, i) => (
          <span
            key={tag}
            className={cx(styles.chip, armed && i === value.length - 1 && styles.chipArmed)}
            data-testid="tag-chip"
          >
            {tag}
            {disabled !== true && (
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={t("tagInput.remove", { tag })}
                onClick={() => remove(tag)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className={styles.entry}
          value={text}
          disabled={disabled}
          placeholder={value.length === 0 ? t("tagInput.placeholder") : ""}
          data-testid={testId}
          aria-label={t("table.tags")}
          onChange={(e) => {
            setText(e.target.value);
            setArmed(false);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (pasted === "") return;
            e.preventDefault();
            add(pasted);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // 未確定の入力は捨てずに確定する。候補クリックを拾えるよう少し待つ
            window.setTimeout(() => {
              setFocused(false);
              setArmed(false);
              setActive(-1);
              if (normalizeTag(text) !== "") add(text);
            }, 120);
          }}
        />
      </div>
      {showSuggestions &&
        createPortal(
          <ul className={styles.suggestions} role="listbox" style={listStyle()}>
            {suggestions.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={cx(styles.suggestion, i === active && styles.suggestionActive)}
                  data-testid="tag-suggestion"
                  // blur より先に拾う（onClick だと入力欄の blur で消えてしまう）
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(s);
                  }}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
      {error !== null && <p className={styles.error}>{error}</p>}
    </div>
  );
}
