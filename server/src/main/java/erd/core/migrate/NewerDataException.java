package erd.core.migrate;

/**
 * データがサーバーより新しい形式（data.schemaVersion &gt; CURRENT_VERSION）。
 * 起動を中止し、データには一切触れない（古いツールが新しいデータを壊さない）。
 */
public class NewerDataException extends RuntimeException {
    private final int dataVersion;
    private final int serverVersion;

    public NewerDataException(int dataVersion, int serverVersion) {
        super("This data uses a newer format (v" + dataVersion + "). Update erd-server.jar. "
                + "This server supports up to v" + serverVersion + ".");
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
