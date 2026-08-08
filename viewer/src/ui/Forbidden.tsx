/**
 * サーバーが 403 を返したとき（トークン不一致）の案内。
 *
 * 403 の原因は実質ひとつしかない: **起動 URL のトークン（`?t=…`）がサーバーと一致していない**
 * （§8.5 の `authorized()`）。データ配信・API のどちらも同じトークンで守られているため、
 * 現れ方は2通りある:
 *
 * - `data`: 起動時にデータそのものが読めない（ふつうはこちら。何も表示できない）
 * - `edit`: データは読めているのに編集 API だけ拒まれる（トークンが途中で変わった場合など）
 *
 * どちらも「見つかりません」「データがありません」で片付けず、**次に何をすればよいか**まで書く。
 */
import { useI18n } from "../i18n/useI18n";
import { Link } from "./Link";
import styles from "./Forbidden.module.scss";

export function Forbidden({
  scope = "data",
  backHref,
  backLabel,
}: {
  scope?: "data" | "edit";
  /** 戻り先。起動時（データが1つも読めない）は戻る先が無いので省略する */
  backHref?: string;
  backLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.wrap} data-testid="forbidden">
      <div className={styles.box}>
        <h2 className={styles.title}>
          {scope === "edit" ? t("forbidden.editTitle") : t("forbidden.dataTitle")}
        </h2>
        <p className={styles.lead}>
          {scope === "edit" ? t("forbidden.editLead") : t("forbidden.dataLead")}
        </p>
        <ol className={styles.steps}>
          <li>{t("forbidden.step1")}</li>
          <li>{t("forbidden.step2")}</li>
          <li>{t("forbidden.step3")}</li>
        </ol>
        {backHref !== undefined && (
          <p>
            <Link className="button-link" href={backHref}>
              {backLabel}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
