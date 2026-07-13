package erd.core.fixtures;

import erd.core.model.Column;
import erd.core.model.ProjectConfig;
import erd.core.model.ProjectModel;
import erd.core.model.Table;
import erd.core.model.TableSchema;
import erd.introspect.RawSchema;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** 逆生成の差分・適用テスト用のモデル（既存の data/** 側と DB 側）。 */
public final class DiffFixtures {

    /** 既存の data/**（users / orders / organizations + ページ core + 辞書）。 */
    public static ProjectModel model() {
        return model(ProjectConfig.EMPTY);
    }

    public static ProjectModel model(ProjectConfig config) {
        return new ProjectModel(FixtureModels.manifest(), config, FixtureModels.dictionary(),
                List.of(FixtureModels.usersTable(), FixtureModels.ordersTable(),
                        FixtureModels.organizationsTable()),
                List.of(FixtureModels.coreDiagram()));
    }

    /** DB 側が既存と完全に一致する状態（差分ゼロ = T-1 の期待）。 */
    public static RawSchema sameAsModel() {
        return raw(FixtureModels.usersTable().schema(), FixtureModels.ordersTable().schema(),
                FixtureModels.organizationsTable().schema());
    }

    public static RawSchema raw(TableSchema... tables) {
        return new RawSchema("PostgreSQL", "16.2", "org.postgresql.Driver 42.7.3", "public",
                Arrays.asList(tables), List.of());
    }

    /** テーブル定義の一部を差し替える（カラムの追加・削除・変更を作るため）。 */
    public static TableSchema withColumns(TableSchema s, List<Column> columns) {
        return new TableSchema(s.name(), s.schema(), s.comment(), columns, s.primaryKey(),
                s.uniques(), s.indexes(), s.foreignKeys(), s.dialect());
    }

    public static TableSchema renamed(TableSchema s, String newName) {
        return new TableSchema(newName, s.schema(), s.comment(), s.columns(), s.primaryKey(),
                s.uniques(), s.indexes(), s.foreignKeys(), s.dialect());
    }

    public static TableSchema withComment(TableSchema s, String comment) {
        return new TableSchema(s.name(), s.schema(), comment, s.columns(), s.primaryKey(),
                s.uniques(), s.indexes(), s.foreignKeys(), s.dialect());
    }

    /** カラム1件を置き換える（型変更・NULL可変更）。 */
    public static TableSchema replaceColumn(TableSchema s, String name, Column replacement) {
        List<Column> columns = new ArrayList<>();
        for (Column c : s.columns()) {
            columns.add(c.name().equals(name) ? replacement : c);
        }
        return withColumns(s, columns);
    }

    public static TableSchema addColumn(TableSchema s, Column column) {
        List<Column> columns = new ArrayList<>(s.columns());
        columns.add(column);
        return withColumns(s, columns);
    }

    public static TableSchema dropColumn(TableSchema s, String name) {
        List<Column> columns = s.columns().stream().filter(c -> !c.name().equals(name)).toList();
        return withColumns(s, columns);
    }

    /** テーブルの全項目ID（プレビュー既定 = 全選択）。 */
    public static java.util.Set<String> selectAll(erd.core.diff.DiffPlan plan) {
        java.util.Set<String> ids = new java.util.LinkedHashSet<>();
        plan.index().forEach((id, item) -> {
            if (item.selectable()) ids.add(id);
        });
        return ids;
    }

    public static Table table(ProjectModel model, String id) {
        return model.table(id).orElseThrow();
    }

    public static Map<String, String> noProps() {
        return Map.of();
    }

    private DiffFixtures() { }
}
