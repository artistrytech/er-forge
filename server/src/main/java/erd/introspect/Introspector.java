package erd.introspect;

import java.sql.Connection;
import java.sql.SQLException;

/** 層1: JDBC 標準。DatabaseMetaData のみを使用し、すべてのドライバで動作する（§7.1）。 */
public interface Introspector {
    RawSchema introspect(Connection conn, IntrospectOptions opts) throws SQLException;
}
