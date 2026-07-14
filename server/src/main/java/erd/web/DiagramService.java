package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import erd.core.io.DataFileParser;
import erd.core.io.DataFilePrinter;
import erd.core.io.ProjectStore;
import erd.core.model.DiagramPage;
import erd.core.model.EdgeLayout;
import erd.core.model.Manifest;
import erd.core.model.NodeLayout;
import erd.core.model.Point;
import erd.core.model.Table;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * ER図ページの部分更新（H-01〜H-04 / §4.4）。
 *
 * <p>部分更新（変更されたキーのみ受け取る）は外部変更の巻き添えを最小化するため。
 * 書き込み直前にディスク上の実ファイルを読み直して内容ハッシュを検証し、
 * 不一致なら1バイトも書かずに STALE を返す（INV-5）。
 */
public final class DiagramService {

    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9._-]+");

    private final DataFileParser parser = new DataFileParser();
    private final DataFilePrinter printer = new DataFilePrinter();
    private final ProjectStore store = new ProjectStore();

    public sealed interface Outcome permits Ok, Stale, NotFound, Duplicate, Invalid {}

    /** writtenFiles: relPath → 新しい内容ハッシュ（SSE の自己判定・応答の newHash に使う）。 */
    public record Ok(String newHash, Map<String, String> writtenFiles) implements Outcome {}

    public record Stale(String currentHash) implements Outcome {}

    public record NotFound() implements Outcome {}

    /** I-01: 既に同じ ID のページがある（既存ページを黙って潰さない）。 */
    public record Duplicate(String id) implements Outcome {}

    public record Invalid(String message) implements Outcome {}

    /**
     * @param body { baseHash, force, title, order, nodes: { id: {pos,w}|null }, edges: { id: {waypoints}|null } }
     */
    public Outcome patch(Path dataDir, String diagramId, JsonNode body) {
        if (!SAFE_ID.matcher(diagramId).matches()) return new NotFound();
        Path file = dataDir.resolve("diagrams/" + diagramId + ".js");
        if (!Files.isRegularFile(file)) return new NotFound();

        byte[] current;
        try {
            current = Files.readAllBytes(file);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        String currentHash = Hashes.sha256(current);
        boolean force = body.path("force").asBoolean(false);
        String baseHash = body.path("baseHash").asText("");
        if (!force && !currentHash.equals(baseHash)) {
            return new Stale(currentHash);
        }
        if (body.has("title") && body.get("title").asText("").isBlank()) {
            return new Invalid("ページ名を入力してください");
        }

        DiagramPage page = parser.parseDiagram(new String(current, StandardCharsets.UTF_8)).value();
        DiagramPage patched = apply(page, body);
        String content = printer.printDiagram(patched);

        Map<String, String> written = new LinkedHashMap<>();
        String newHash = Hashes.sha256(content.getBytes(StandardCharsets.UTF_8));
        try {
            if (!newHash.equals(currentHash)) {
                FileWrites.writeAtomic(file, content);
                written.put("diagrams/" + diagramId + ".js", newHash);
            }
            // ノードの追加 / 除去は index.js の tables[].diagrams に、タイトル・表示順（I-03）は
            // manifest.js に影響する。条件分岐で最適化せず、書き込み後は必ず両方を再生成する
            // （何が変わったかを判定すると必ず漏れる。§8.2 と同じ方針）
            regenerateDerived(dataDir, written, page.id(), patched);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return new Ok(newHash, written);
    }

    // ----------------------------------------------------- ページの追加 / 削除（I-01 / I-02）

    /**
     * I-01: ページの追加。空のページファイルを作り、manifest.js を再生成する。
     * 新規ページにノードは無いため、スキーマ情報には一切影響しない。
     *
     * @param body { id, title, order }
     */
    public Outcome create(Path dataDir, JsonNode body) {
        String id = body.path("id").asText("").trim();
        if (!SAFE_ID.matcher(id).matches()) {
            return new Invalid("ページID は英数字と . _ - のみ使えます: " + id);
        }
        String title = body.path("title").asText("").trim();
        if (title.isEmpty()) return new Invalid("ページ名を入力してください");

        Path file = dataDir.resolve("diagrams/" + id + ".js");
        if (Files.exists(file)) return new Duplicate(id);

        ProjectStore.LoadResult loaded = store.read(dataDir);
        List<DiagramPage> pages = new ArrayList<>(loaded.model().diagrams());
        if (pages.stream().anyMatch(d -> d.id().equals(id))) return new Duplicate(id);

        int order = body.has("order") ? body.get("order").asInt()
                : pages.stream().mapToInt(DiagramPage::order).max().orElse(0) + 1;
        DiagramPage page = new DiagramPage(id, title, order, Map.of(), Map.of());
        pages.add(page);

        String content = printer.printDiagram(page);
        String newHash = Hashes.sha256(content.getBytes(StandardCharsets.UTF_8));
        Map<String, String> written = new LinkedHashMap<>();
        try {
            Files.createDirectories(file.getParent());
            FileWrites.writeAtomic(file, content);
            written.put("diagrams/" + id + ".js", newHash);
            regenerateDerived(dataDir, written, loaded.model().manifest(),
                    loaded.model().tables(), pages);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return new Ok(newHash, written);
    }

    /**
     * I-02: ページの削除。ダイアグラムファイルを消すだけで、スキーマ情報には影響しない。
     * baseHash はページファイルに対して検証する（外部で編集されたページを黙って消さない）。
     */
    public Outcome delete(Path dataDir, String diagramId, JsonNode body) {
        if (!SAFE_ID.matcher(diagramId).matches()) return new NotFound();
        Path file = dataDir.resolve("diagrams/" + diagramId + ".js");
        if (!Files.isRegularFile(file)) return new NotFound();

        String currentHash = Hashes.sha256(file);
        boolean force = body.path("force").asBoolean(false);
        if (!force && !currentHash.equals(body.path("baseHash").asText(""))) {
            return new Stale(currentHash);
        }

        ProjectStore.LoadResult loaded = store.read(dataDir);
        List<DiagramPage> pages = loaded.model().diagrams().stream()
                .filter(d -> !d.id().equals(diagramId)).toList();

        Map<String, String> written = new LinkedHashMap<>();
        try {
            Files.delete(file);
            written.put("diagrams/" + diagramId + ".js", null);
            regenerateDerived(dataDir, written, loaded.model().manifest(),
                    loaded.model().tables(), pages);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return new Ok(null, written);
    }

    /** ページの baseHash（編集開始前の取得用）。 */
    public String baseHash(Path dataDir, String diagramId) {
        if (!SAFE_ID.matcher(diagramId).matches()) return null;
        Path file = dataDir.resolve("diagrams/" + diagramId + ".js");
        return Files.isRegularFile(file) ? Hashes.sha256(file) : null;
    }

    // ------------------------------------------------------------- 派生ファイル

    /** patch 経路: ディスク上のモデルを読み直し、対象ページだけ patch 後の値に差し替える。 */
    private void regenerateDerived(Path dataDir, Map<String, String> written, String diagramId,
                                   DiagramPage patched) throws IOException {
        ProjectStore.LoadResult loaded = store.read(dataDir);
        List<DiagramPage> pages = loaded.model().diagrams().stream()
                .map(d -> d.id().equals(diagramId) ? patched : d).toList();
        regenerateDerived(dataDir, written, loaded.model().manifest(), loaded.model().tables(), pages);
    }

    private void regenerateDerived(Path dataDir, Map<String, String> written, Manifest manifest,
                                   List<Table> tables, List<DiagramPage> pages) throws IOException {
        String manifestHash = FileWrites.regenerateManifest(dataDir, manifest, tables, pages);
        if (manifestHash != null) written.put("manifest.js", manifestHash);
        String indexHash = FileWrites.regenerateIndex(dataDir, tables, pages);
        if (indexHash != null) written.put("index.js", indexHash);
    }

    // ------------------------------------------------------------ patch 適用

    private DiagramPage apply(DiagramPage page, JsonNode body) {
        Map<String, NodeLayout> nodes = new LinkedHashMap<>(page.nodes());
        JsonNode nodePatch = body.path("nodes");
        for (Iterator<String> it = nodePatch.fieldNames(); it.hasNext(); ) {
            String id = it.next();
            JsonNode v = nodePatch.get(id);
            if (v == null || v.isNull()) {
                nodes.remove(id); // null = このページから除去（I-06）
            } else {
                nodes.put(id, mergeNode(nodes.get(id), v));
            }
        }
        Map<String, EdgeLayout> edges = new LinkedHashMap<>(page.edges());
        JsonNode edgePatch = body.path("edges");
        for (Iterator<String> it = edgePatch.fieldNames(); it.hasNext(); ) {
            String id = it.next();
            JsonNode v = edgePatch.get(id);
            if (v == null || v.isNull()) {
                edges.remove(id);
            } else {
                edges.put(id, mergeEdge(edges.get(id), v));
            }
        }
        // I-03: ページ名・表示順の変更。省略時は既存値のまま
        String title = body.has("title") ? body.get("title").asText().trim() : page.title();
        int order = body.has("order") ? body.get("order").asInt() : page.order();
        return new DiagramPage(page.id(), title, order, nodes, edges, page.unknown());
    }

    /** 既存ノードの unknown / 省略されたキー（w）は保持する。座標は防御的に再正規化する（INV-2）。 */
    private NodeLayout mergeNode(NodeLayout existing, JsonNode v) {
        Point pos = v.has("pos") ? snap(v.get("pos"))
                : existing != null ? existing.pos() : new Point(0, 0);
        Integer w = v.has("w")
                ? (v.get("w").isNull() ? null : v.get("w").asInt())
                : existing != null ? existing.w() : null;
        Map<String, JsonNode> unknown = new LinkedHashMap<>();
        if (existing != null) unknown.putAll(existing.unknown());
        v.properties().forEach(e -> {
            if (!e.getKey().equals("pos") && !e.getKey().equals("w")) {
                unknown.put(e.getKey(), e.getValue());
            }
        });
        return new NodeLayout(pos, w, unknown);
    }

    private EdgeLayout mergeEdge(EdgeLayout existing, JsonNode v) {
        List<Point> waypoints = new ArrayList<>();
        if (v.has("waypoints")) {
            for (JsonNode p : v.get("waypoints")) {
                waypoints.add(snap(p));
            }
        } else if (existing != null) {
            waypoints.addAll(existing.waypoints());
        }
        Map<String, JsonNode> unknown = new LinkedHashMap<>();
        if (existing != null) unknown.putAll(existing.unknown());
        v.properties().forEach(e -> {
            if (!e.getKey().equals("waypoints")) {
                unknown.put(e.getKey(), e.getValue());
            }
        });
        return new EdgeLayout(waypoints, unknown);
    }

    /** 8px グリッドスナップ + 整数化（§5.11 / INV-2）。二重丸めを避けるため double から直接スナップする。 */
    private static Point snap(JsonNode arr) {
        return new Point((int) Math.round(arr.path(0).asDouble() / 8.0) * 8,
                (int) Math.round(arr.path(1).asDouble() / 8.0) * 8);
    }

}
