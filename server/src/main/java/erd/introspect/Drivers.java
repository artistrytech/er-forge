package erd.introspect;

import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.ServiceLoader;
import java.util.logging.Logger;
import java.util.stream.Stream;

/**
 * JDBC ドライバの動的ロード（§7.2 / K-01）。
 *
 * <p>{@code DriverManager} は<b>呼び出し元のクラスローダーから見えるドライバしか使わない</b>ため、
 * {@code drivers/*.jar} を URLClassLoader で読んだだけでは接続できない。委譲するだけの薄い
 * ラッパ（{@link DriverShim}）を DriverManager に登録することで、この制限を回避する。
 */
public final class Drivers {

    /** GUI に表示するロード済みドライバ（K-01）。 */
    public record Info(String className, String version, String source) {}

    private static final List<Info> LOADED = new ArrayList<>();
    private static boolean scanned;

    /** {@code drivers/} 配下の jar を走査して登録する（起動時に1回）。 */
    public static synchronized void scan(Path driversDir) {
        if (scanned) return;
        scanned = true;
        List<Path> jars = List.of();
        if (Files.isDirectory(driversDir)) {
            try (Stream<Path> files = Files.list(driversDir)) {
                jars = files.filter(p -> p.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".jar"))
                        .sorted()
                        .toList();
            } catch (IOException e) {
                System.err.println("Warning: Could not read drivers/: " + e.getMessage());
            }
        }
        if (!jars.isEmpty()) {
            URL[] urls = jars.stream().map(Drivers::toUrl).filter(u -> u != null).toArray(URL[]::new);
            URLClassLoader cl = new URLClassLoader(urls, Drivers.class.getClassLoader());
            for (Driver d : ServiceLoader.load(Driver.class, cl)) {
                try {
                    DriverManager.registerDriver(new DriverShim(d));
                    LOADED.add(new Info(d.getClass().getName(),
                            d.getMajorVersion() + "." + d.getMinorVersion(), "drivers/"));
                } catch (SQLException e) {
                    System.err.println("Warning: Could not register driver: "
                            + d.getClass().getName() + " (" + e.getMessage() + ")");
                }
            }
        }
        // 起動方式B（クラスパス指定）で読み込まれたドライバも列挙する（§7.2）
        Enumeration<Driver> registered = DriverManager.getDrivers();
        while (registered.hasMoreElements()) {
            Driver d = registered.nextElement();
            if (d instanceof DriverShim) continue;
            LOADED.add(new Info(d.getClass().getName(),
                    d.getMajorVersion() + "." + d.getMinorVersion(), "classpath"));
        }
        LOADED.sort(Comparator.comparing(Info::className));
    }

    public static synchronized List<Info> loaded() {
        return List.copyOf(LOADED);
    }

    /**
     * ダウンロード直後の jar を登録する（サーバー再起動なしで反映。§7.2）。
     *
     * <p>{@link #scan} と同じく DriverShim 経由で DriverManager に登録する。既に同じドライバクラスが
     * ロード済みなら二重登録を避けてスキップする（起動時スキャンとの重複対策）。
     *
     * @return 登録後のロード済み一覧
     */
    public static synchronized List<Info> registerJar(Path jar) {
        if (jar == null || !Files.isRegularFile(jar)) return loaded();
        URL url = toUrl(jar);
        if (url == null) return loaded();
        URLClassLoader cl = new URLClassLoader(new URL[]{url}, Drivers.class.getClassLoader());
        for (Driver d : ServiceLoader.load(Driver.class, cl)) {
            String className = d.getClass().getName();
            boolean already = LOADED.stream().anyMatch(i -> i.className().equals(className));
            if (already) continue;
            try {
                DriverManager.registerDriver(new DriverShim(d));
                LOADED.add(new Info(className,
                        d.getMajorVersion() + "." + d.getMinorVersion(), "drivers/"));
            } catch (SQLException e) {
                System.err.println("Warning: Could not register driver: "
                        + className + " (" + e.getMessage() + ")");
            }
        }
        LOADED.sort(Comparator.comparing(Info::className));
        return loaded();
    }

    public static Connection connect(String url, String user, String password,
                                     java.util.Map<String, String> extra) throws SQLException {
        Properties props = new Properties();
        if (extra != null) {
            extra.forEach((k, v) -> {
                if (k != null && !k.isBlank() && v != null) props.setProperty(k, v);
            });
        }
        if (user != null && !user.isEmpty()) props.setProperty("user", user);
        if (password != null && !password.isEmpty()) props.setProperty("password", password);
        return DriverManager.getConnection(url, props);
    }

    private static URL toUrl(Path p) {
        try {
            return p.toUri().toURL();
        } catch (Exception e) {
            return null;
        }
    }

    /** DriverManager に登録するための薄いラッパ。すべての呼び出しを委譲するだけ。 */
    private static final class DriverShim implements Driver {
        private final Driver delegate;

        DriverShim(Driver delegate) {
            this.delegate = delegate;
        }

        @Override
        public Connection connect(String url, Properties info) throws SQLException {
            return delegate.connect(url, info);
        }

        @Override
        public boolean acceptsURL(String url) throws SQLException {
            return delegate.acceptsURL(url);
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException {
            return delegate.getPropertyInfo(url, info);
        }

        @Override
        public int getMajorVersion() {
            return delegate.getMajorVersion();
        }

        @Override
        public int getMinorVersion() {
            return delegate.getMinorVersion();
        }

        @Override
        public boolean jdbcCompliant() {
            return delegate.jdbcCompliant();
        }

        @Override
        public Logger getParentLogger() throws SQLFeatureNotSupportedException {
            return delegate.getParentLogger();
        }
    }

    private Drivers() { }
}
