/**
 * ドライバ設定（§7.2）。逆生成画面の入口だけに置く。
 *
 * <b>設定は config.js（Git 管理・チーム共有）に保存し、jar の実体は drivers/（各自）に置く。</b>
 * これにより、一人が「どのドライバを・どのバージョンで」設定すれば、他メンバーは初回に
 * その設定へ従ってダウンロードするだけで同じ構成を再現できる（配布物には同梱しない）。
 */
import { useMemo, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { catalogKey, defaultVersion, parseCoordinate } from "./driverCoords";
import type { DriverCatalogEntry, DriverInfo } from "./types";
import styles from "./DriverSetup.module.scss";

export interface DriverSelection {
  mavenRepository: string;
  artifacts: string[];
}

export function DriverSetup({
  loaded,
  catalog,
  configured,
  missing,
  disabled,
  busy,
  onSave,
  onDownload,
}: {
  loaded: DriverInfo[];
  catalog: DriverCatalogEntry[];
  configured: { mavenRepository: string; artifacts: string[] };
  missing: string[];
  disabled: boolean;
  busy: boolean;
  onSave: (selection: DriverSelection) => void;
  onDownload: (artifacts: string[]) => void;
}) {
  const { t } = useI18n();

  // 設定済み座標を「カタログ一致ぶん」と「カタログ外（カスタム）ぶん」に分ける
  const configuredByKey = useMemo(() => {
    const map = new Map<string, string>(); // key -> version
    for (const a of configured.artifacts) {
      const p = parseCoordinate(a);
      if (p) map.set(p.key, p.version);
    }
    return map;
  }, [configured.artifacts]);

  const custom = useMemo(() => {
    const catalogKeys = new Set(catalog.map(catalogKey));
    return configured.artifacts.filter((a) => {
      const p = parseCoordinate(a);
      return p === null || !catalogKeys.has(p.key);
    });
  }, [configured.artifacts, catalog]);

  const [repo, setRepo] = useState(configured.mavenRepository);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(catalog.filter((e) => configuredByKey.has(catalogKey(e))).map((e) => e.id)),
  );
  const [versions, setVersions] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const e of catalog) {
      v[e.id] = configuredByKey.get(catalogKey(e)) ?? defaultVersion(e);
    }
    return v;
  });
  const [customText, setCustomText] = useState(custom.join("\n"));

  const buildSelection = (): DriverSelection => {
    const artifacts: string[] = [];
    for (const e of catalog) {
      if (!checked.has(e.id)) continue;
      const p = parseCoordinate(e.coordinate);
      const key = p?.key ?? e.coordinate;
      const ver = (versions[e.id] ?? "").trim() || defaultVersion(e);
      artifacts.push(`${key}:${ver}`);
    }
    for (const line of customText.split("\n").map((s) => s.trim()).filter((s) => s !== "")) {
      artifacts.push(line);
    }
    return { mavenRepository: repo.trim(), artifacts };
  };

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  return (
    <section className="form-section">
      <h3>{t("introspect.drivers")}</h3>
      <p className="muted">{t("introspect.driversHint")}</p>

      {missing.length > 0 && (
        <div className="notice-banner" data-testid="drivers-missing">
          {t("introspect.driversMissing", { n: missing.length })}
          <button
            type="button"
            className="header-button header-button-primary"
            disabled={disabled || busy}
            data-testid="download-missing"
            onClick={() => onDownload(missing)}
            style={{ marginInlineStart: "0.5rem" }}
          >
            {busy ? t("introspect.driversDownloading") : t("introspect.driversDownload")}
          </button>
        </div>
      )}

      <div className="form-row">
        <label htmlFor="maven-repo">{t("introspect.driversRepo")}</label>
        <input
          id="maven-repo"
          type="text"
          className="mono"
          data-testid="maven-repo"
          value={repo}
          disabled={disabled}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="https://repo1.maven.org/maven2"
        />
      </div>

      <table className="driver-catalog" data-testid="driver-catalog">
        <thead>
          <tr>
            <th />
            <th>{t("introspect.driversDb")}</th>
            <th>{t("introspect.driversVersion")}</th>
            <th>{t("introspect.driversStatus")}</th>
          </tr>
        </thead>
        <tbody>
          {catalog.map((e) => {
            const key = catalogKey(e);
            // ステータスは「保存済み(config.js)」の状態を表す（編集中のバージョンではなく）
            const savedVer = configuredByKey.get(key);
            const isConfigured = savedVer !== undefined;
            const isMissing = isConfigured && missing.includes(`${key}:${savedVer}`);
            const isReady = isConfigured && !isMissing;
            return (
              <tr key={e.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={e.label}
                    data-testid={`driver-check-${e.id}`}
                    checked={checked.has(e.id)}
                    disabled={disabled}
                    onChange={() => toggle(e.id)}
                  />
                </td>
                <td>{e.label}</td>
                <td>
                  <input
                    type="text"
                    className="mono"
                    data-testid={`driver-version-${e.id}`}
                    value={versions[e.id] ?? ""}
                    disabled={disabled || !checked.has(e.id)}
                    onChange={(ev) => setVersions({ ...versions, [e.id]: ev.target.value })}
                    size={16}
                  />
                </td>
                <td>
                  {isMissing ? (
                    <span className="badge badge-medium">{t("introspect.driversNotDownloaded")}</span>
                  ) : isReady ? (
                    <span className="badge">{t("introspect.driversReady")}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <details className={styles.driverCustom}>
        <summary className="muted">{t("introspect.driversCustom")}</summary>
        <p className="muted">{t("introspect.driversCustomHint")}</p>
        <textarea
          className="paste-area mono"
          rows={2}
          value={customText}
          disabled={disabled}
          data-testid="driver-custom"
          onChange={(e) => setCustomText(e.target.value)}
          placeholder="com.ibm.db2:jcc:11.5.9.0"
        />
      </details>

      {loaded.length > 0 && (
        <ul className="driver-list">
          {loaded.map((d) => (
            <li key={d.className} className="mono">
              {d.className} <span className="muted">{d.version}</span>{" "}
              <span className="badge">{d.source}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="form-actions">
        <button
          type="button"
          className="header-button"
          disabled={disabled || busy}
          data-testid="save-drivers"
          onClick={() => onSave(buildSelection())}
        >
          {t("introspect.driversSave")}
        </button>
      </div>
    </section>
  );
}
