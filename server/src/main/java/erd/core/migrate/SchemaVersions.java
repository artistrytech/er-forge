package erd.core.migrate;

import java.util.List;

/** データ形式の現行バージョンと、登録済みの移行の列。 */
public final class SchemaVersions {
    private SchemaVersions() {}

    /**
     * 後方互換を破る変更のときのみインクリメントする（§6.5）。
     * キーの追加では上げない（未知キーは保持される。V-4）。
     */
    public static final int CURRENT = 1;

    /** 登録済みの移行（fromVersion 昇順）。v2 が生まれたらここに追加する。 */
    public static final List<Migration> MIGRATIONS = List.of();
}
