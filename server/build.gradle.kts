plugins {
    java
    id("com.gradleup.shadow") version "8.3.8"
}

/*
 * リリースバージョンはリポジトリ直下の VERSION が単一の真実源。
 * viewer/vite.config.ts も同じファイルを読み、index.html に焼き込む
 * （静的モードにはサーバーが居ないため、ビューア側は自前で版を持つしかない）。
 *
 * リリースビルド（build-dist.bat / build-dist.sh）だけが ERD_RELEASE=1 を立てて確定版になる。
 * それ以外の手元ビルドは -dev を付け、リリース済みの版と見分けが付くようにする。
 */
val releaseBuild = providers.environmentVariable("ERD_RELEASE").orNull == "1"
version = file("../VERSION").readText().trim() + if (releaseBuild) "" else "-dev"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.fasterxml.jackson.core:jackson-databind:2.17.2")
    implementation("io.javalin:javalin:6.7.0")
    implementation("org.slf4j:slf4j-simple:2.0.17")

    // 自動レイアウト（H-07 / H-08）。layered アルゴリズムのメタデータは
    // ServiceLoader で発見されるため、shadowJar 側の mergeServiceFiles が必須
    implementation("org.eclipse.elk:org.eclipse.elk.core:0.10.0")
    implementation("org.eclipse.elk:org.eclipse.elk.alg.layered:0.10.0")

    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")

    // JDBC 標準内省（層1）の検証用。H2 と SQLite はプロセス内で完結するため常時実行できる。
    // MySQL / SQL Server / Oracle は dev-db の docker compose に接続して検証する（未起動なら skip）。
    // MySQL だけは層2（MysqlEnhancer）の検証も兼ねる。
    // これらのドライバは配布物には同梱しない（利用者が逆生成画面からダウンロードして
    // drivers/ に置く。§7.2）。サーバー本体は drivers/*.jar を URLClassLoader で読むため、
    // implementation に入れてはならない。ここで検証したバージョンを DriverCatalog の既定にする。
    testImplementation("com.h2database:h2:2.2.224")
    testImplementation("org.xerial:sqlite-jdbc:3.46.1.3")
    testImplementation("com.mysql:mysql-connector-j:9.1.0")
    testImplementation("com.microsoft.sqlserver:mssql-jdbc:12.8.1.jre11")
    testImplementation("com.oracle.database.jdbc:ojdbc11:23.5.0.24.07")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("fixtures.dir", file("../fixtures").absolutePath)
    // 追加 DB 検証用の DDL 置き場（Phase 7）。SQL Server / Oracle のテストは
    // dev-db の docker compose に接続し、ここの DDL を流してから内省する。
    systemProperty("devdb.dir", file("../dev-db").absolutePath)
}

// golden fixture の再生成（出力を目視確認してコミットする。CI では実行しない）
tasks.register<JavaExec>("generateFixtures") {
    group = "verification"
    description = "Regenerate golden fixtures under ../fixtures"
    mainClass = "erd.core.tools.GenerateFixtures"
    classpath = sourceSets["test"].runtimeClasspath
    args(file("../fixtures").absolutePath)
}

// 同梱サンプルデータの再生成（dev-db の PostgreSQL 初期スキーマ → resources/erd-sample。
// 出力をコミットする）。入力は dev-db の 000_init.sql と共用で、二重管理を避けている
tasks.register<JavaExec>("generateSampleData") {
    group = "build"
    description = "Regenerate bundled sample data from dev-db/postgresql/migrations/000_init.sql"
    mainClass = "erd.core.tools.GenerateSampleData"
    classpath = sourceSets["test"].runtimeClasspath
    args(
        file("../dev-db/postgresql/migrations/000_init.sql").absolutePath,
        file("src/main/resources/erd-sample").absolutePath,
    )
}

// ------------------------------------------------------------------ 開発用の起動

// 開発用サーバー: gradlew devServer（ビューアは別ターミナルで npm run dev:server）
//
// プロジェクトディレクトリ（＝設計書 §3.3 の erd/）として ../dev/ を使う。
// 初回は data/ が空なのでブートストラップ画面が出る（サンプル取り込みですぐ試せる）。
// JDBC ドライバを使うなら dev/drivers/ に jar を置く。
//
// index.html はここからは配信しない（vite dev が配信し、/__erd と /data をここへプロキシする）。
// トークンは vite 側が URL に埋められるよう固定する（Main の ERD_TOKEN。127.0.0.1 限定は不変）。
//
// 注意: ここを /** ... */ の KDoc にしないこと。Kotlin のブロックコメントは入れ子になるため、
// 本文に "drivers/*.jar" のような /* を含む文字列があると、そこから内側のコメントが開き、
// 閉じ */ は内側を閉じるだけになる。以降のスクリプト全体が静かにコメント化され、
// 構文エラーも出ないままタスクが丸ごと消える（実際にこれを踏んだ）。
val devDir = file("../dev")

tasks.register<JavaExec>("devServer") {
    group = "application"
    description = "Starts the development server (data: ../dev/, viewer: npm run dev:server)"
    mainClass = "erd.web.Main"
    classpath = sourceSets["main"].runtimeClasspath
    workingDir = devDir
    environment("ERD_NO_BROWSER", "1")
    environment("ERD_TOKEN", System.getenv("ERD_TOKEN") ?: "erd-dev")
    System.getenv("ERD_PORT")?.let { environment("ERD_PORT", it) }
    doFirst {
        devDir.resolve("drivers").mkdirs()
    }
}

// ---------------------------------------------------------------- 配布物（§3.1）

tasks.shadowJar {
    archiveFileName = "erd-server.jar"
    manifest {
        // Implementation-* は AppVersion が Package 経由で読む（GET /__erd/health の appVersion）
        attributes(
            "Main-Class" to "erd.web.Main",
            "Implementation-Title" to "erd-server",
            "Implementation-Version" to project.version.toString(),
        )
    }
    mergeServiceFiles()
}

// ビューアのビルド（vite）。配布物の index.html を作る
val npmBuild = tasks.register<Exec>("npmBuild") {
    group = "build"
    description = "Build viewer (single-file index.html) via npm"
    workingDir = file("../viewer")
    // 版の付け方を jar と揃える（vite.config.ts が同じ VERSION を読む）
    environment("ERD_RELEASE", if (releaseBuild) "1" else "0")
    val isWindows = System.getProperty("os.name").lowercase().contains("win")
    commandLine(if (isWindows) listOf("cmd", "/c", "npm", "run", "build")
                else listOf("npm", "run", "build"))
}

/**
 * 配布 ZIP の組み立て（設計書 §3.1）。
 *   erd.zip
 *   ├── erd-server.jar / index.html / erd.sh / erd.bat / README.md
 *   ├── THIRD-PARTY-NOTICES.txt （同梱 OSS の著作権・ライセンス表示。distribution/ の固定ファイル）
 *   ├── .gitignore / .gitattributes （展開先 erd/ の Git 運用設定。distribution/ の固定ファイル。
 *                         Ant の既定除外に入っているため settings.gradle.kts で除外を外している）
 *   └── drivers/        （空。README のみ。JDBC ドライバは逆生成画面から
 *                         各自ダウンロードするか、手動で jar を置く。§7.2）
 * 実行: gradlew packageDist → build/dist/erd.zip を GitHub Releases に手動アップロード
 *
 * ファイル名にバージョンは入れない（展開先の erd/ を差し替える運用のため、
 * ダウンロードしたファイル名が毎回同じであるほうが手順を書きやすい）。
 *
 * ドライバを同梱しないのは意図的: (1) 再配布に伴うライセンス問題（MySQL は GPL、
 * Oracle は proprietary）を避け、(2) ZIP を小さく保つ。既定バージョンは DriverCatalog、
 * チーム共有の設定は erd/config.js の drivers に置く（全ワークスペース共通）。
 */
tasks.register<Zip>("packageDist") {
    group = "build"
    description = "Assemble the release ZIP under build/dist"
    dependsOn(tasks.shadowJar, npmBuild)
    archiveFileName = "erd.zip"
    destinationDirectory = layout.buildDirectory.dir("dist")
    from(tasks.shadowJar.flatMap { it.archiveFile })
    from("../viewer/dist/index.html")
    from("../distribution") {
        filesMatching("erd.sh") {
            permissions { unix("rwxr-xr-x") }
        }
    }
}
