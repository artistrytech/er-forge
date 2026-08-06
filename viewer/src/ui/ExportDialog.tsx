/**
 * 配置のエクスポート（H-13 / 詳細設計 §8.2）。
 * 現在の view を ERD.diagram({...}) の生コードとして表示し、コピーできるようにする。
 * 静的モードの唯一の保存手段であり、ロック喪失時の救済手段でもある。
 * 出力はサーバーの決定論的プリンタとバイト一致する（golden fixture で保証）。
 */
import { useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import {
  printDiagram,
  type DiagramPage,
  type EdgeLayout,
  type JsonValue,
  type NodeLayout,
} from "../lib/printer/diagramPrinter";
import { useEditStore } from "../model/editStore";
import { useAppStore } from "../model/store";
import type { Diagram } from "../model/types";
import { Dialog } from "./Dialog";
import styles from "./ExportDialog.module.scss";

export function ExportDialog({ diagramId }: { diagramId: string }) {
  const { t } = useI18n();
  const closeExport = useEditStore((s) => s.closeExport);
  const diagram = useAppStore((s) => s.diagrams[diagramId]);
  const manifest = useAppStore((s) => s.manifest);
  const [copied, setCopied] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const code = useMemo(() => {
    if (!diagram) return "";
    const ref = manifest?.diagrams?.find((d) => d.id === diagramId);
    return printDiagram(toPrinterPage(diagram, ref?.title, ref?.order));
  }, [diagram, manifest, diagramId]);

  const copy = () => {
    const area = areaRef.current;
    if (!area) return;
    area.select();
    // file:// では clipboard API が使えないことがあるため execCommand にフォールバック
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done, () => {
        document.execCommand("copy");
        done();
      });
    } else {
      document.execCommand("copy");
      done();
    }
  };

  return (
    <Dialog title={t("export.title")} onClose={closeExport} size="wide">
      <p className={styles.exportHint}>{t("export.hint", { file: `data/diagrams/${diagramId}.js` })}</p>
      <textarea
        ref={areaRef}
        className={styles.exportCode}
        readOnly
        value={code}
        rows={18}
        spellCheck={false}
        data-testid="export-code"
      />
      <div className="dialog-actions">
        <button type="button" onClick={copy}>
          {copied ? t("export.copied") : t("export.copy")}
        </button>
        <button type="button" onClick={closeExport}>
          {t("export.close")}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * zod でパースした view（looseObject。未知キーはオブジェクト直下に残る）を
 * プリンタの入力形式（既知キー + unknown マップ）へ移し替える。
 */
function toPrinterPage(d: Diagram, fallbackTitle?: string, fallbackOrder?: number): DiagramPage {
  const KNOWN_PAGE = new Set(["id", "title", "order", "nodes", "edges"]);
  const KNOWN_NODE = new Set(["pos", "w"]);
  const KNOWN_EDGE = new Set(["waypoints"]);

  const nodes: Record<string, NodeLayout> = {};
  for (const [id, n] of Object.entries(d.nodes ?? {})) {
    nodes[id] = {
      pos: n.pos,
      w: n.w,
      unknown: pickUnknown(n as Record<string, unknown>, KNOWN_NODE),
    };
  }
  const edges: Record<string, EdgeLayout> = {};
  for (const [id, e] of Object.entries(d.edges ?? {})) {
    edges[id] = {
      waypoints: e.waypoints,
      unknown: pickUnknown(e as Record<string, unknown>, KNOWN_EDGE),
    };
  }
  return {
    id: d.id,
    title: d.title ?? fallbackTitle ?? d.id,
    order: d.order ?? fallbackOrder ?? 1,
    nodes,
    edges,
    unknown: pickUnknown(d as Record<string, unknown>, KNOWN_PAGE),
  };
}

function pickUnknown(
  obj: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, JsonValue> | undefined {
  let result: Record<string, JsonValue> | undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (known.has(k) || v === undefined) continue;
    (result ??= {})[k] = v as JsonValue;
  }
  return result;
}
