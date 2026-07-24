package erd.core.model;

import java.util.List;

/**
 * data/config.js の {@code drivers}（human-owned・Git 管理・チーム共有）。
 *
 * <p>「どの JDBC ドライバを・どのバージョンで・どの Maven リポジトリから取得するか」を宣言する。
 * jar の実体は {@code drivers/}（Git 管理外）に置かれ、各メンバーが自分の環境へダウンロードする。
 * つまり<b>設定（何を）は共有、実体（jar）と接続情報（秘密）は各自</b>という分担になる（§7.2）。
 *
 * <p>{@code mavenRepository} が空なら既定（Maven Central）を使う。{@code artifacts} は
 * {@code group:artifact:version} 形式の座標を人が書いた順で保持する（ソートしない）。
 */
public record DriverConfig(String mavenRepository, List<String> artifacts) {

    public static final DriverConfig EMPTY = new DriverConfig(null, List.of());

    public DriverConfig {
        artifacts = artifacts == null ? List.of() : List.copyOf(artifacts);
    }

    public boolean isEmpty() {
        return (mavenRepository == null || mavenRepository.isBlank()) && artifacts.isEmpty();
    }
}
