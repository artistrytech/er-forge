package erd.core.migrate;

/**
 * データがサーバーより新しい形式（data.schemaVersion &gt; CURRENT_VERSION）。
 * 起動を中止し、データには一切触れない（古いツールが新しいデータを壊さない）。
 */
public class NewerDataException extends RuntimeException {
    private final int dataVersion;
    private final int serverVersion;

    public NewerDataException(int dataVersion, int serverVersion) {
        super("このデータは新しい形式（v" + dataVersion + "）です。erd-server.jar を更新してください"
                + "（サーバーは v" + serverVersion + " まで対応）");
        this.dataVersion = dataVersion;
        this.serverVersion = serverVersion;
    }

    public int dataVersion() {
        return dataVersion;
    }

    public int serverVersion() {
        return serverVersion;
    }
}
