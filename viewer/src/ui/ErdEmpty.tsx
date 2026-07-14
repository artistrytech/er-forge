/**
 * ページが1枚も無いときの ER図 画面（`#/erd`）。
 *
 * 逆生成（K-11）は `data/diagrams/**` を一切書かないため、DB から生成した直後は
 * テーブルだけがあってページが 0 件になる。設計書 §3.4 の運用フローは
 * 「逆生成 → **ページを作成して配置** → コミット」であり、その最初の一歩がここにある。
 * ここに導線が無いと、逆生成の直後に行き止まりになる。
 */
import { useI18n } from "../i18n/useI18n";
import { useAppStore } from "../model/store";
import { CreateFirstPageButton } from "./AddPage";
import { Link } from "./Link";
import { hrefs } from "./router";

export function ErdEmpty() {
  const { t } = useI18n();
  const serverMode = useAppStore((s) => s.serverMode === true);
  const tableCount = useAppStore((s) => s.index?.tables?.length ?? 0);

  return (
    <div className="empty-state" data-testid="erd-empty">
      <h2>{t("erdEmpty.title")}</h2>
      <p>{t("erdEmpty.body", { n: tableCount })}</p>
      {serverMode ? (
        <>
          <p>
            <CreateFirstPageButton />
          </p>
          <p className="form-hint">{t("erdEmpty.hint")}</p>
        </>
      ) : (
        <p>{t("erdEmpty.staticOnly")}</p>
      )}
      <p>
        <Link className="button-link" href={hrefs.tables()}>
          {t("notFound.toTables")}
        </Link>
      </p>
    </div>
  );
}
