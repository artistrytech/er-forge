package erd.web;

/**
 * アプリのリリースバージョン（A-02）。
 *
 * <p>値はリポジトリ直下の {@code VERSION} が単一の真実源で、ビルド時に
 * {@code erd-server.jar} のマニフェスト（Implementation-Version）へ焼き込まれる
 * （server/build.gradle.kts）。ビューア側は同じファイルを vite が index.html に焼き込む。
 *
 * <p>クラスディレクトリから直接動かす開発時（gradlew devServer）はマニフェストが無いため
 * {@code "dev"} になる。データ形式の版（{@code schemaVersion}）とは独立した軸で、
 * 連動させない。
 */
public final class AppVersion {

    private static final String VALUE = read();

    private AppVersion() {
    }

    /** 例: "0.2.0"（リリースビルド）/ "0.2.0-dev"（手元ビルド）/ "dev"（jar 外実行） */
    public static String current() {
        return VALUE;
    }

    private static String read() {
        String v = AppVersion.class.getPackage().getImplementationVersion();
        return v == null || v.isBlank() ? "dev" : v;
    }
}
