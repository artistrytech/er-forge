/** 未知のルート・存在しない ID の表示（B-11）。白画面にせず #/tables への導線を出す */
import { useI18n } from "../i18n/useI18n";
import { hrefs } from "./router";
import { Link } from "./Link";

export function NotFound({ path }: { path: string }) {
  const { t } = useI18n();
  return (
    <div className="empty-state">
      <h2>{t("notFound.title")}</h2>
      <p>{t("notFound.message", { path })}</p>
      <p>
        <Link className="button-link" href={hrefs.tables()}>
          {t("notFound.toTables")}
        </Link>
      </p>
    </div>
  );
}
