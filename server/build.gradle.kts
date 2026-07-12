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

    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
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
