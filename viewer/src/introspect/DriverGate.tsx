/**
 * ドライバ未整備のときに逆生成画面を塞ぐモーダル（§7.2）。
 *
 * <b>解決するまで逆生成画面の他の操作をブロックする。</b> Dialog と違い、Esc / 背景クリック / × では
 * 閉じられない（唯一の出口は「取得する」か「逆生成をやめる」）。
 *
 *  - mode="confirm": config.js にドライバが宣言済みだが未取得。ダウンロードの確認のみ。
 *  - mode="setup"  : ドライバが1つも無く、設定もされていない。使う DB を選ばせてから取得する。
 */
import { useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { catalogKey, defaultVersion } from "./driverCoords";
import type { DriverCatalogEntry } from "./types";

export interface GateSelection {
  mavenRepository: string;
  artifacts: string[];
}

export function DriverGate({
  mode,
  catalog,
  configured,
  missing,
  busy,
  error,
  disabled,
  onConfirmDownload,
  onSetupAndDownload,
  onLeave,
}: {
  mode: "setup" | "confirm";
  catalog: DriverCatalogEntry[];
  configured: { mavenRepository: string; artifacts: string[] };
  missing: string[];
  busy: boolean;
  error: string | null;
  disabled: boolean;
  onConfirmDownload: () => void;
  onSetupAndDownload: (sel: GateSelection) => void;
  onLeave: () => void;
}) {
  const { t } = useI18n();
  const [repo, setRepo] = useState(configured.mavenRepository);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [versions, setVersions] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const e of catalog) v[e.id] = defaultVersion(e);
    return v;
  });

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const buildSelection = (): GateSelection => {
    const artifacts: string[] = [];
    for (const e of catalog) {
      if (!checked.has(e.id)) continue;
      const key = catalogKey(e);
      const ver = (versions[e.id] ?? "").trim() || defaultVersion(e);
      artifacts.push(`${key}:${ver}`);
    }
    return { mavenRepository: repo.trim(), artifacts };
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" data-testid="driver-gate">
        <div className="dialog-header">
          <div className="dialog-title">
            {mode === "setup" ? t("introspect.gateSetupTitle") : t("introspect.gateConfirmTitle")}
          </div>
        </div>
        <div className="dialog-body">
          {error !== null && <div className="error-banner">{error}</div>}

          {mode === "confirm" ? (
            <>
              <p>{t("introspect.gateConfirmBody")}</p>
              <ul className="driver-list" data-testid="gate-missing">
                {missing.map((c) => (
                  <li key={c} className="mono">
                    {c}
                  </li>
                ))}
              </ul>
              <p className="muted mono">{configured.mavenRepository}</p>
              <div className="dialog-actions">
                <button type="button" onClick={onLeave}>
                  {t("introspect.gateLeave")}
                </button>
                <button
                  type="button"
                  className="header-button-primary"
                  disabled={busy || disabled}
                  data-testid="gate-download"
                  onClick={onConfirmDownload}
                >
                  {busy ? t("introspect.driversDownloading") : t("introspect.driversDownload")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p>{t("introspect.gateSetupBody")}</p>
              <div className="form-row">
                <label htmlFor="gate-maven-repo">{t("introspect.driversRepo")}</label>
                <input
                  id="gate-maven-repo"
                  type="text"
                  className="mono"
                  data-testid="gate-maven-repo"
                  value={repo}
                  disabled={disabled}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="https://repo1.maven.org/maven2"
                />
              </div>
              <table className="driver-catalog" data-testid="gate-catalog">
                <thead>
                  <tr>
                    <th />
                    <th>{t("introspect.driversDb")}</th>
                    <th>{t("introspect.driversVersion")}</th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={e.label}
                          data-testid={`gate-check-${e.id}`}
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
                          data-testid={`gate-version-${e.id}`}
                          value={versions[e.id] ?? ""}
                          disabled={disabled || !checked.has(e.id)}
                          onChange={(ev) => setVersions({ ...versions, [e.id]: ev.target.value })}
                          size={16}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="dialog-actions">
                <button type="button" onClick={onLeave}>
                  {t("introspect.gateLeave")}
                </button>
                <button
                  type="button"
                  className="header-button-primary"
                  disabled={busy || disabled || checked.size === 0}
                  data-testid="gate-setup"
                  onClick={() => onSetupAndDownload(buildSelection())}
                >
                  {busy ? t("introspect.driversDownloading") : t("introspect.gateSetupAction")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
