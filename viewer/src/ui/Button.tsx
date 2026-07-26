/**
 * ボタンの見た目を1か所に集約する共有コンポーネント。
 *
 * これまで各画面が `button-link` / `header-button` / `header-button-primary` を直接書いており、
 * 同じ役割のボタンでも画面ごとに見た目が食い違っていた（welcome の [作成する] と
 * ER図 の [最初のページを作成] など）。役割を variant で表し、クラス名は外に出さない。
 *
 * | variant | 用途 | 見た目 |
 * |---|---|---|
 * | `accent` | 画面上の主導線（空状態からの1歩目・welcome の作成） | アクセント色の塗り |
 * | `primary` | ダイアログの確定 | 濃色（ink）の塗り |
 * | `default` | 併記する副操作・キャンセル | 枠線のみ |
 * | `danger`  | 破壊的操作（リセット・削除） | 赤枠 → ホバーで赤塗り |
 */
import type { ButtonHTMLAttributes } from "react";
import { cx } from "../lib/cx";
import styles from "./Button.module.scss";

export type ButtonVariant = "accent" | "primary" | "default" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = "default", className, type, ...rest }: ButtonProps) {
  return (
    <button
      // 既定を button にする（フォーム内で暗黙の submit にならないように）
      type={type ?? "button"}
      className={cx(styles.button, styles[variant], className)}
      {...rest}
    />
  );
}
