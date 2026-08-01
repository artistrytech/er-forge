/**
 * ヘッダのプルダウン（ワークスペース切替・設定・information）の共通の開閉。
 *
 * 外側クリックと Esc で閉じる。返した ref はメニュー全体（ボタン + ドロップダウン）を包む
 * 要素に付ける。その内側のクリックは「外側」に数えない。
 *
 * 排他制御は要らない: 別のメニューのボタンを押すと、そのクリックがこちらの外側判定に当たって
 * 閉じるため、複数が同時に開いたままにはならない。
 */
import { useEffect, useRef, useState, type RefObject } from "react";

export interface Dropdown<T extends HTMLElement> {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  ref: RefObject<T | null>;
}

export function useDropdown<T extends HTMLElement = HTMLDivElement>(): Dropdown<T> {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { open, setOpen, toggle: () => setOpen((o) => !o), ref };
}
