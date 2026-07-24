package erd.introspect;

import java.util.List;

/**
 * 既定で提示する JDBC ドライバのカタログ（§7.2）。
 *
 * <p>bootstrap ではなく<b>逆生成画面の入口</b>で提示する（サンプルデータだけ試したい人に
 * ドライバ設定を強制しないため）。ここの座標は build.gradle.kts の testImplementation で
 * 実際に内省を検証したものと揃える（＝配れる/使えることを確認済みのバージョンを既定にする）。
 *
 * <p>あくまで<b>既定値</b>であり、利用者は config.js でバージョン・Maven リポジトリを
 * 任意に上書きでき、カタログに無い DB のドライバ座標を足すこともできる。
 */
public final class DriverCatalog {

    /** 既定の Maven リポジトリ（config.js で上書き可能）。 */
    public static final String DEFAULT_MAVEN_REPOSITORY = "https://repo1.maven.org/maven2";

    /**
     * @param id         安定した内部 ID（UI のチェック状態の対応付けに使う）
     * @param label      表示名
     * @param coordinate 既定座標 group:artifact:version
     */
    public record Entry(String id, String label, String coordinate) {}

    private static final List<Entry> ENTRIES = List.of(
            new Entry("postgresql", "PostgreSQL", "org.postgresql:postgresql:42.7.4"),
            new Entry("mysql", "MySQL / MariaDB", "com.mysql:mysql-connector-j:9.1.0"),
            new Entry("sqlserver", "SQL Server", "com.microsoft.sqlserver:mssql-jdbc:12.8.1.jre11"),
            new Entry("oracle", "Oracle", "com.oracle.database.jdbc:ojdbc11:23.5.0.24.07"),
            new Entry("sqlite", "SQLite", "org.xerial:sqlite-jdbc:3.46.1.3"),
            new Entry("h2", "H2", "com.h2database:h2:2.2.224"));

    public static List<Entry> entries() {
        return ENTRIES;
    }

    private DriverCatalog() {}
}
