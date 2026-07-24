package erd.introspect;

import erd.core.io.DataFileParser;
import erd.core.io.DataFilePrinter;
import erd.core.model.ProjectConfig;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * §7.2: config.js の drivers ブロックの往復と、Maven 座標・リポジトリの検証。
 */
class DriverConfigTest {

    private final DataFileParser parser = new DataFileParser();
    private final DataFilePrinter printer = new DataFilePrinter();

    @Test
    @DisplayName("drivers ブロックが決定論的に往復する")
    void driversRoundTrip() {
        String config = """
                ERD.config({
                  ignoreTables: [
                    "public.tmp_*",
                  ],
                  drivers: {
                    mavenRepository: "https://repo1.maven.org/maven2",
                    artifacts: [
                      "org.postgresql:postgresql:42.7.4",
                      "com.mysql:mysql-connector-j:9.1.0",
                    ],
                  },
                });
                """;
        ProjectConfig parsed = parser.parseConfig(config).value();
        assertEquals("https://repo1.maven.org/maven2", parsed.drivers().mavenRepository());
        assertEquals(2, parsed.drivers().artifacts().size());
        assertEquals(config, printer.printConfig(parsed), "round-trip must be byte-identical");
        assertEquals(printer.printConfig(parsed), printer.printConfig(parsed), "must be idempotent");
    }

    @Test
    @DisplayName("drivers 無しの config.js は従来どおり（drivers ブロックを出力しない）")
    void noDriversStaysEmpty() {
        String config = "ERD.config({\n});\n";
        ProjectConfig parsed = parser.parseConfig(config).value();
        assertTrue(parsed.drivers().isEmpty());
        assertEquals(config, printer.printConfig(parsed));
    }

    @Test
    @DisplayName("座標の検証: 妥当な形式のみ受理し、パストラバーサルを弾く")
    void coordinateValidation() {
        assertNotNull(DriverDownloader.parse("org.postgresql:postgresql:42.7.4"));
        assertNotNull(DriverDownloader.parse("com.h2database:h2:2.2.224"));
        assertNull(DriverDownloader.parse("org.postgresql:postgresql"), "must be group:artifact:version");
        assertNull(DriverDownloader.parse("a:b:c:d"));
        assertNull(DriverDownloader.parse("../evil:x:1"), "no path traversal");
        assertNull(DriverDownloader.parse("a/b:c:1"), "no slashes");
        assertNull(DriverDownloader.parse("a: :1"), "no blanks");
    }

    @Test
    @DisplayName("座標からの Maven パス生成")
    void repositoryPath() {
        DriverDownloader.Coordinate c = DriverDownloader.parse("org.postgresql:postgresql:42.7.4");
        assertNotNull(c);
        assertEquals("org/postgresql/postgresql/42.7.4/postgresql-42.7.4.jar", c.repositoryPath());
        assertEquals("postgresql-42.7.4.jar", c.jarFileName());
    }

    @Test
    @DisplayName("リポジトリ URL の正規化: http(s) のみ、末尾スラッシュ除去、空は既定")
    void repositoryNormalization() {
        assertEquals("https://repo1.maven.org/maven2",
                DriverDownloader.normalizeRepository("https://repo1.maven.org/maven2/"));
        assertEquals(DriverCatalog.DEFAULT_MAVEN_REPOSITORY,
                DriverDownloader.normalizeRepository(""));
        assertEquals(DriverCatalog.DEFAULT_MAVEN_REPOSITORY,
                DriverDownloader.normalizeRepository(null));
        assertNull(DriverDownloader.normalizeRepository("file:///etc/passwd"));
        assertNull(DriverDownloader.normalizeRepository("ftp://x/y"));
    }

    @Test
    @DisplayName("カタログの既定座標はすべて妥当")
    void catalogCoordinatesValid() {
        assertFalse(DriverCatalog.entries().isEmpty());
        for (DriverCatalog.Entry e : DriverCatalog.entries()) {
            assertNotNull(DriverDownloader.parse(e.coordinate()), "invalid catalog coordinate: " + e.coordinate());
        }
    }
}
