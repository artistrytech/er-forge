/**
 * 閲覧用 ZIP（A-11）のファイル名規則と、GUI が提示する CLI コマンド。
 * 検査規則は Java 側（ViewerExport.prefixError）の写しなので、ここが落ちたら両方を見る。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_PREFIX,
  exportCommand,
  exportPrefixError,
} from "../src/lib/viewerExport";

describe("exportPrefixError", () => {
  it("ファイル名に使える文字は通す（日本語・空白・記号）", () => {
    expect(exportPrefixError(DEFAULT_EXPORT_PREFIX)).toBeNull();
    expect(exportPrefixError("売上 ER図_v2.1")).toBeNull();
    expect(exportPrefixError("a")).toBeNull();
  });

  it("ファイルを作れない・作ると事故になるものだけを弾く", () => {
    expect(exportPrefixError("")).toBe("viewerExport.error.empty");
    expect(exportPrefixError("x".repeat(65))).toBe("viewerExport.error.tooLong");
    expect(exportPrefixError("a\nb")).toBe("viewerExport.error.control");
    for (const ch of ['\\', "/", ":", "*", "?", '"', "<", ">", "|"]) {
      expect(exportPrefixError(`a${ch}b`)).toBe("viewerExport.error.forbidden");
    }
    expect(exportPrefixError(" x")).toBe("viewerExport.error.edges");
    expect(exportPrefixError("x ")).toBe("viewerExport.error.edges");
    expect(exportPrefixError("x.")).toBe("viewerExport.error.edges");
    expect(exportPrefixError("CON")).toBe("viewerExport.error.reserved");
    expect(exportPrefixError("nul.zip")).toBe("viewerExport.error.reserved");
  });
});

describe("exportCommand", () => {
  const base = { prefix: DEFAULT_EXPORT_PREFIX, workspaces: ["a", "b"], total: 2, windows: true };

  it("既定と同じ選択なら最短形（オプションを付けない）", () => {
    expect(exportCommand(base)).toBe("erd.bat export");
    expect(exportCommand({ ...base, windows: false })).toBe("./erd.sh export");
  });

  it("既定と違うところだけをオプションにする", () => {
    expect(exportCommand({ ...base, prefix: "sales" })).toBe("erd.bat export --prefix=sales");
    expect(exportCommand({ ...base, workspaces: ["a"] })).toBe("erd.bat export --workspaces=a");
    expect(exportCommand({ ...base, prefix: "sales", workspaces: ["b"] })).toBe(
      "erd.bat export --prefix=sales --workspaces=b",
    );
  });

  it("空白や日本語を含む値は貼り付けられるよう引用符で囲む", () => {
    expect(exportCommand({ ...base, prefix: "売上 ER図" })).toBe('erd.bat export --prefix="売上 ER図"');
  });
});
