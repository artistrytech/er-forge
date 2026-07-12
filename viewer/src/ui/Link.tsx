/**
 * 画面遷移を伴う要素の共通コンポーネント（X-04）。
 * 実体のある <a href="#/..."> であり、Ctrl/⌘+クリック・中クリック・右クリック・
 * ホバー時の URL 表示はブラウザ標準の挙動に委ねる。
 * ハッシュ遷移はページを再読込しないため preventDefault も不要。
 */
import type { AnchorHTMLAttributes, ReactNode } from "react";

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  children: ReactNode;
}

export function Link({ href, children, ...rest }: LinkProps) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
