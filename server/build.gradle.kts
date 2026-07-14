plugins {
    java
    id("com.gradleup.shadow") version "8.3.8"
}

version = "0.2.0"

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

    // JDBC 標準内省（層1）の検証用。実 DB（PostgreSQL / MySQL）に対する検証は
    // Testcontainers で別途行う（Docker が要るため CI の必須ゲートからは外す）
    testImplementation("com.h2database:h2:2.2.224")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("fixtures.dir", file("../fixtures").absolutePath)
}

// golden fixture の再生成（出力を目視確認してコミットする。CI では実行しない）
tasks.register<JavaExec>("generateFixtures") {
    group = "verification"
    description = "Regenerate golden fixtures under ../fixtures"
    mainClass = "erd.core.tools.GenerateFixtures"
    classpath = sourceSets["test"].runtimeClasspath
    args(file("../fixtures").absolutePath)
}

// 同梱サンプルデータの再生成（.docs/sample-schema.sql → resources/erd-sample。出力をコミットする）
tasks.register<JavaExec>("generateSampleData") {
    group = "build"
    description = "Regenerate bundled sample data from .docs/sample-schema.sql"
    mainClass = "erd.core.tools.GenerateSampleData"
    classpath = sourceSets["test"].runtimeClasspath
    args(
        file("../.docs/sample-schema.sql").absolutePath,
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
        attributes("Main-Class" to "erd.web.Main")
    }
    mergeServiceFiles()
}

// ビューアのビルド（vite）。配布物の index.html を作る
val npmBuild = tasks.register<Exec>("npmBuild") {
    group = "build"
    description = "Build viewer (single-file index.html) via npm"
    workingDir = file("../viewer")
    val isWindows = System.getProperty("os.name").lowercase().contains("win")
    commandLine(if (isWindows) listOf("cmd", "/c", "npm", "run", "build")
                else listOf("npm", "run", "build"))
}

/**
 * 配布 ZIP の組み立て（設計書 §3.1）。
 *   erd-<version>.zip
 *   ├── erd-server.jar / index.html / erd.sh / erd.bat / README.md
 *   └── drivers/        （JDBC ドライバの置き場。追加はユーザーが行う）
 * 実行: gradlew packageDist → build/dist/erd-<version>.zip を GitHub Releases に手動アップロード
 */
tasks.register<Zip>("packageDist") {
    group = "build"
    description = "Assemble the release ZIP under build/dist"
    dependsOn(tasks.shadowJar, npmBuild)
    archiveFileName = "erd-${project.version}.zip"
    destinationDirectory = layout.buildDirectory.dir("dist")
    from(tasks.shadowJar.flatMap { it.archiveFile })
    from("../viewer/dist/index.html")
    from("../distribution") {
        filesMatching("erd.sh") {
            permissions { unix("rwxr-xr-x") }
        }
    }
}
