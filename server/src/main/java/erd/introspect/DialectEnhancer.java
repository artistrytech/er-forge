package erd.introspect;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.SQLException;

/**
 * 層2: 任意。DB固有情報（CHECK 制約・ENUM 値・部分インデックス等）を追加 SQL で補完する（§7.1）。
 *
 * <p>{@link java.util.ServiceLoader} で発見する。層1だけで最低限動作するため、
 * Enhancer が1つも無くても未知の DB に対応できる（フェーズ6で PostgreSQL / MySQL 用を同梱する）。
 */
public interface DialectEnhancer {

    /** getDatabaseProductName() で判定する。 */
    boolean supports(DatabaseMetaData md) throws SQLException;

    /** RawSchema の dialect を書き足す。 */
    RawSchema enhance(Connection conn, RawSchema schema) throws SQLException;
}
