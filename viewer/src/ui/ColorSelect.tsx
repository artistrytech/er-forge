/**
 * 色の選択（P-13）。用意したトークンから選ぶだけで、任意の色は指定できない
 * （理由は model/colors.ts）。色は**タグとは独立**しており、タグを付けなくても色だけ付けられる。
 */
import { useI18n } from "../i18n/useI18n";
import { cx } from "../lib/cx";
import { COLOR_TOKENS } from "../model/colors";
import styles from "./ColorSelect.module.scss";

interface ColorSelectProps {
  /** "" は未設定 */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  testId?: string;
}

export function ColorSelect({ value, onChange, disabled, testId }: ColorSelectProps) {
  const { t } = useI18n();
  return (
    <div className={styles.colorSelect} role="radiogroup" aria-label={t("colorSelect.label")} data-testid={testId}>
      <button
        type="button"
        role="radio"
        aria-checked={value === ""}
        aria-label={t("colorSelect.none")}
        title={t("colorSelect.none")}
        disabled={disabled}
        className={cx(styles.swatch, styles.none, value === "" && styles.selected)}
        onClick={() => onChange("")}
      />
      {COLOR_TOKENS.map((token) => (
        <button
          key={token}
          type="button"
          role="radio"
          aria-checked={value === token}
          aria-label={t(`color.${token}` as const)}
          title={t(`color.${token}` as const)}
          disabled={disabled}
          data-color={token}
          data-testid={`color-${token}`}
          className={cx(styles.swatch, value === token && styles.selected)}
          onClick={() => onChange(token)}
        />
      ))}
    </div>
  );
}
