/** Maven 座標 "group:artifact:version" のための小さなヘルパ（DriverSetup / DriverGate 共用）。 */
import type { DriverCatalogEntry } from "./types";

/** "group:artifact:version" を分解する。妥当でなければ null。 */
export function parseCoordinate(coord: string): { key: string; version: string } | null {
  const parts = coord.split(":");
  if (parts.length !== 3 || parts.some((p) => p.trim() === "")) return null;
  return { key: `${parts[0]}:${parts[1]}`, version: parts[2]! };
}

/** カタログ座標の group:artifact 部分（設定との対応付けキー）。 */
export function catalogKey(entry: DriverCatalogEntry): string {
  return parseCoordinate(entry.coordinate)?.key ?? entry.coordinate;
}

/** カタログ座標の既定バージョン。 */
export function defaultVersion(entry: DriverCatalogEntry): string {
  return parseCoordinate(entry.coordinate)?.version ?? "";
}
