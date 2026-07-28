package erd.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import erd.core.apply.ApplyResult;
import erd.core.apply.DependencyException;
import erd.core.apply.IntrospectApplier;
import erd.core.diff.DiffPlan;
import erd.core.diff.PatternList;
import erd.core.diff.RenameCandidate;
import erd.core.diff.RenameDecision;
import erd.core.diff.SchemaDiff;
import erd.core.io.DataFileParser;
import erd.core.io.DataFilePrinter;
import erd.core.io.ProjectStore;
import erd.core.migrate.SchemaVersions;
import erd.core.model.DiagramPage;
import erd.core.model.Dictionary;
import erd.core.model.Manifest;
import erd.core.model.ProjectConfig;
import erd.core.model.ProjectModel;
import erd.core.model.Table;
import erd.introspect.Dialects;
import erd.introspect.Drivers;
import erd.introspect.IntrospectOptions;
import erd.introspect.JdbcIntrospector;
import erd.introspect.RawSchema;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

/**
 * 逆生成のプレビューと適用（K-07〜K-14 / 詳細設計 §1・§6・§9）。
 *
 * <p><b>プレビューは1バイトも書き込まない</b>（INV-4）。内省結果はセッション（メモリ、TTL 30分）に
 * スナップショットとして保持し、ユーザーがリネームを判断している間 DB へ再接続しない。
 *
 * <p>適用は「全ファイルが成功するか、1ファイルも変わらないか」のいずれか（INV-5）。
 * 完成形を<b>メモリ上で全生成 → 検証 → バックアップ → 変更のあったファイルだけを置換</b>する。
 * 内容が同じファイルは書かないため、逆生成で {@code diagrams/**} の mtime すら動かない（T-3）。
 */
final class IntrospectService {

    private static final Duration TTL = Duration.ofMinutes(30);

    /**
     * プレビューのスナップショット（§1）。適用まで DB に再接続しない。
     * どのワークスペースで取ったプレビューかを持ち、他のワークスペースへは適用させない。
     */
    record Session(String id, String workspaceId, Instant expiresAt, RawSchema raw,
                   IntrospectOptions options, String url, String fingerprint) {}

    sealed interface Outcome permits Ok, Gone, Stale, Bad, Failed {}

    record Ok(Object body, String revision, Map<String, String> writtenFiles) implements Outcome {}

    record Gone(String message) implements Outcome {}

    record Stale(String currentFingerprint) implements Outcome {}

    record Bad(String code, String message, List<String> itemIds) implements Outcome {}

    record Failed(String message) implements Outcome {}

    private final ObjectMapper mapper = new ObjectMapper();
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final SchemaDiff diff = new SchemaDiff();
    private final IntrospectApplier applier = new IntrospectApplier();
    private final ProjectStore store = new ProjectStore();
    private final DataFileParser parser = new DataFileParser();
    private final DataFilePrinter printer = new DataFilePrinter();
    private final ConfigService config = new ConfigService();
    private final ConnectionStore connections = new ConnectionStore();

    // ------------------------------------------------------------ 接続テスト

    /** K-04: 疎通確認。製品名・バージョン・ネームスペース一覧を返す。 */
    Map<String, Object> test(JsonNode body) throws SQLException {
        try (Connection conn = connect(body)) {
            var md = conn.getMetaData();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("product", md.getDatabaseProductName());
            out.put("version", md.getDatabaseProductVersion());
            out.put("driver", md.getDriverName() + " " + md.getDriverVersion());
            out.put("namespaces", JdbcIntrospector.namespaces(conn));
            return out;
        }
    }

    private Connection connect(JsonNode body) throws SQLException {
        JsonNode c = body.has("connection") ? body.get("connection") : body;
        Map<String, String> props = new LinkedHashMap<>();
        JsonNode p = c.path("properties");
        if (p.isObject()) {
            p.fields().forEachRemaining(e -> props.put(e.getKey(), e.getValue().asText("")));
        }
        return Drivers.connect(c.path("url").asText(""), c.path("user").asText(""),
                c.path("password").asText(""), props);
    }

    // -------------------------------------------------------------- プレビュー

    /** K-07 → K-08: 内省を実行し、差分プレビューを返す（書き込みなし。INV-4）。 */
    Outcome preview(String workspaceId, Path erdDir, Path dataDir, JsonNode body) throws SQLException {
        JsonNode scope = body.path("scope");
        List<String> include = strings(scope.path("include"));
        List<String> exclude = strings(scope.path("exclude"));
        String namespace = scope.path("namespace").asText("");
        IntrospectOptions options = new IntrospectOptions(namespace, include, exclude);

        RawSchema raw;
        try (Connection conn = connect(body)) {
            // 層1（JDBC 標準）→ 層2（DialectEnhancer。§7.1）。層2の失敗は警告に落として続行する
            raw = Dialects.enhance(conn, new JdbcIntrospector().introspect(conn, options));
        }

        String url = body.path("connection").path("url").asText("");
        Session session = new Session("s-" + UUID.randomUUID(), workspaceId, Instant.now().plus(TTL),
                raw, options, url, Hashes.fingerprint(dataDir));
        sessions.put(session.id(), session);
        purgeExpired();

        DiffPlan plan = plan(dataDir, session, List.of());
        return new Ok(response(erdDir, session, plan, List.of()), null, Map.of());
    }

    /** GET /__erd/w/:ws/introspect/:sessionId（ブラウザのリロード対策）。失効時は 410。 */
    Outcome reload(String workspaceId, Path erdDir, Path dataDir, String sessionId,
                   List<RenameDecision> decisions) {
        Session session = session(sessionId, workspaceId);
        if (session == null) {
            return new Gone("The preview has expired. Run it again.");
        }
        DiffPlan plan = plan(dataDir, session, decisions);
        return new Ok(response(erdDir, session, plan, decisions), null, Map.of());
    }

    /**
     * プランはリネーム決定に依存するため、決定が変わるたびにサーバーで再計算する
     * （差分ロジックを UI に二重実装しない）。DB へは再接続しない（スナップショットから計算する）。
     */
    private DiffPlan plan(Path dataDir, Session session, List<RenameDecision> decisions) {
        PatternList ignore = PatternList.of(config.read(dataDir).ignoreTables());
        return diff.plan(readModel(dataDir), session.raw(), ignore, decisions);
    }

    /**
     * 既存の data/**。まだ無い場合（初回起動のブートストラップ「既存のスキーマから生成する」。§3.6）は
     * 空のモデルとして扱う。すべてが「追加」の差分になる。
     */
    private ProjectModel readModel(Path dataDir) {
        if (Files.isRegularFile(dataDir.resolve("manifest.js"))) {
            return store.read(dataDir).model();
        }
        Manifest manifest = new Manifest(SchemaVersions.CURRENT,
                "config.js", "dictionary.js", Map.of(), List.of(), Map.of());
        return new ProjectModel(manifest, ProjectConfig.EMPTY, Dictionary.EMPTY, List.of(), List.of());
    }

    private Map<String, Object> response(Path erdDir, Session session, DiffPlan plan,
                                         List<RenameDecision> decisions) {
        List<DiffPlan.Guard> guards = new ArrayList<>(plan.guards());
        // G-4: 前回と接続先 DB が異なる（フィルタ・接続先の取り違えを止める。§8.5）
        String last = connections.lastUrl(erdDir);
        if (last != null && !last.isEmpty() && !last.equals(session.url())) {
            guards.add(new DiffPlan.Guard("DIFFERENT_DB", "warn",
                    "You are connected to a different database than last time (previous: "
                            + last + " / current: " + session.url() + ")."));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", session.id());
        out.put("expiresAt", session.expiresAt().toString());
        out.put("source", Map.of("product", session.raw().product(),
                "version", session.raw().version(), "driver", session.raw().driver()));
        out.put("baseFingerprint", session.fingerprint());
        out.put("stats", plan.stats());
        out.put("items", plan.items());
        out.put("renameCandidates", plan.renameCandidates());
        out.put("guards", guards);
        out.put("ignored", plan.ignored());
        out.put("outOfScope", plan.outOfScope());
        out.put("warnings", plan.warnings());
        out.put("decisions", decisions);
        return out;
    }

    // ------------------------------------------------------------------ 適用

    /**
     * K-09 / K-10 / K-11: 選択とリネーム決定を適用する。
     *
     * @param body { sessionId, baseFingerprint, selection: [...], renameDecisions: [...], confirmed }
     */
    Outcome apply(String workspaceId, Path erdDir, Path dataDir, JsonNode body) {
        Session session = session(body.path("sessionId").asText(""), workspaceId);
        if (session == null) {
            return new Gone("The preview has expired. Run it again.");
        }
        // TOCTOU の回避: 適用直前に必ず取り直して照合する（§6.1 チェック2）
        String current = Hashes.fingerprint(dataDir);
        if (!current.equals(session.fingerprint())) {
            return new Stale(current);
        }

        List<RenameDecision> decisions = decisions(body.path("renameDecisions"));
        DiffPlan plan = plan(dataDir, session, decisions);

        // チェック4: 未決定のリネーム候補がないこと（既定は「未決定」。勝手に承認しない。§4.4）
        Set<String> decided = new LinkedHashSet<>();
        for (RenameDecision d : decisions) {
            decided.add(d.id());
        }
        List<String> undecided = plan.renameCandidates().stream()
                .map(RenameCandidate::id).filter(id -> !decided.contains(id)).toList();
        if (!undecided.isEmpty()) {
            return new Bad("UNDECIDED_RENAME",
                    undecided.size() + " rename candidates are undecided.", undecided);
        }

        // チェック5: ガードに該当する場合、confirmed が必要（§8.5）
        boolean confirmed = body.path("confirmed").asBoolean(false);
        List<DiffPlan.Guard> guards = plan.guards();
        if (!confirmed && !guards.isEmpty()) {
            return new Bad("GUARD", guards.get(0).message(),
                    guards.stream().map(DiffPlan.Guard::code).toList());
        }

        Set<String> selection = new LinkedHashSet<>(strings(body.path("selection")));
        ApplyResult result;
        try {
            result = applier.apply(readModel(dataDir), session.raw(), plan, selection);
        } catch (DependencyException e) {
            return new Bad("DEPENDENCY", e.getMessage(), e.itemIds());
        }

        Map<String, String> rendered = store.renderAll(result.model());
        List<String> failures = validate(dataDir, result.model(), rendered);
        if (!failures.isEmpty()) {
            return new Failed("Apply was aborted because validation failed: " + String.join(" / ", failures));
        }

        Map<String, String> written;
        try {
            written = write(erdDir, dataDir, rendered);
        } catch (IOException e) {
            return new Failed("Write failed: " + e.getMessage());
        }

        sessions.remove(session.id());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("applied", result.applied());
        out.put("skipped", Map.of("count", result.skipped().size(), "itemIds", result.skipped()));
        out.put("logicalNamesSeeded", Map.of("tables", result.seededTables(),
                "columns", result.seededColumns()));
        out.put("unplacedTables", result.unplacedTables());
        out.put("orphanNodes", result.orphanNodes());
        out.put("warnings", result.warnings());
        return new Ok(out, null, written);
    }

    /**
     * 書き出し前の検証（§6.3）。1つでも失敗したら何も差し替えずに中止する（INV-5）。
     * V-1 決定論的プリンタで往復して同一になる / V-2 FK の参照先が存在する /
     * V-6 孤児ノードは許容（K-13）/ V-7 パストラバーサル。
     */
    private List<String> validate(Path dataDir, ProjectModel model, Map<String, String> rendered) {
        List<String> failures = new ArrayList<>();
        Path base = dataDir.normalize();
        for (Map.Entry<String, String> e : rendered.entrySet()) {
            Path target = base.resolve(e.getKey()).normalize();
            if (!target.startsWith(base)) {
                failures.add("V-7 path points outside data/: " + e.getKey());
            }
        }
        for (Table t : model.tables()) {
            String path = "schema/" + (t.schema().schema() == null ? "" : t.schema().schema() + "/")
                    + t.schema().name() + ".js";
            String content = rendered.get(path);
            if (content == null) {
                failures.add("V-4 schema file was not generated: " + t.id());
                continue;
            }
            try {
                Table parsed = parser.parseTable(content).value();
                if (!printer.printTable(parsed).equals(content)) {
                    failures.add("V-1 round trip did not match: " + t.id());
                }
            } catch (RuntimeException ex) {
                failures.add("V-1 readback failed: " + t.id() + " (" + ex.getMessage() + ")");
            }
            Set<String> ids = new LinkedHashSet<>();
            for (Table other : model.tables()) {
                ids.add(other.id());
            }
            for (var fk : t.schema().foreignKeys()) {
                if (!ids.contains(fk.ref().table())) {
                    failures.add("V-2 FK target does not exist: " + t.id() + "." + fk.name());
                }
            }
        }
        for (DiagramPage d : model.diagrams()) {
            String content = rendered.get("diagrams/" + d.id() + ".js");
            if (content == null) {
                failures.add("V-4 diagram file was not generated: " + d.id());
            }
        }
        return failures;
    }

    /**
     * バックアップ → 変更のあったファイルだけを置換 → 不要になったファイルを削除。
     * 途中で失敗したらバックアップから復元し、適用前の状態に完全に戻す（INV-5 / T-7）。
     *
     * @return relPath → 新しい内容ハッシュ（削除は null）。SSE の自己判定に使う
     */
    private Map<String, String> write(Path erdDir, Path dataDir, Map<String, String> rendered)
            throws IOException {
        Set<String> existing = new LinkedHashSet<>();
        if (Files.isDirectory(dataDir)) {
            try (Stream<Path> walk = Files.walk(dataDir)) {
                walk.filter(p -> Files.isRegularFile(p) && p.toString().endsWith(".js"))
                        .map(p -> dataDir.relativize(p).toString().replace('\\', '/'))
                        .forEach(existing::add);
            }
        }
        Path backup = Backups.create(erdDir, dataDir);
        Map<String, String> written = new LinkedHashMap<>();
        try {
            for (Map.Entry<String, String> e : rendered.entrySet()) {
                Path target = dataDir.resolve(e.getKey());
                String hash = Hashes.sha256(e.getValue().getBytes(StandardCharsets.UTF_8));
                // 内容が同じファイルは書かない（diagrams/** の mtime も動かさない。INV-2 / T-3）
                if (Files.isRegularFile(target) && Hashes.sha256(target).equals(hash)) continue;
                Files.createDirectories(target.getParent());
                FileWrites.writeAtomic(target, e.getValue());
                written.put(e.getKey(), hash);
            }
            for (String rel : existing) {
                if (rendered.containsKey(rel)) continue;
                Files.deleteIfExists(dataDir.resolve(rel));
                written.put(rel, null);
            }
            deleteEmptyDirs(dataDir.resolve("schema"));
        } catch (IOException | RuntimeException e) {
            Backups.restore(backup, dataDir);
            throw e instanceof IOException io ? io : new IOException(e);
        }
        return written;
    }

    private static void deleteEmptyDirs(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) return;
        try (Stream<Path> walk = Files.walk(dir)) {
            List<Path> dirs = walk.filter(Files::isDirectory)
                    .sorted(java.util.Comparator.comparingInt(Path::getNameCount).reversed())
                    .toList();
            for (Path p : dirs) {
                if (p.equals(dir)) continue;
                try (Stream<Path> children = Files.list(p)) {
                    if (children.findAny().isEmpty()) Files.delete(p);
                }
            }
        }
    }

    // ------------------------------------------------------------------ 補助

    /** 期限内かつ同じワークスペースで取ったセッションだけを返す（他は失効扱い）。 */
    Session session(String id, String workspaceId) {
        Session s = sessions.get(id);
        if (s == null) return null;
        if (s.expiresAt().isBefore(Instant.now())) {
            sessions.remove(id);
            return null;
        }
        return java.util.Objects.equals(s.workspaceId(), workspaceId) ? s : null;
    }

    private void purgeExpired() {
        Instant now = Instant.now();
        sessions.values().removeIf(s -> s.expiresAt().isBefore(now));
    }

    List<RenameDecision> decisions(JsonNode node) {
        List<RenameDecision> out = new ArrayList<>();
        if (node == null || !node.isArray()) return out;
        for (JsonNode n : node) {
            String id = n.path("id").asText("");
            if (id.isEmpty()) continue;
            out.add(new RenameDecision(id, n.path("decision").asText("accept"),
                    n.path("to").asText(null)));
        }
        return out;
    }

    private static List<String> strings(JsonNode node) {
        List<String> out = new ArrayList<>();
        if (node == null || !node.isArray()) return out;
        for (JsonNode n : node) {
            String s = n.asText("");
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }

    ObjectMapper mapper() {
        return mapper;
    }
}
