package erd.core.io;

/** データファイルの読み込みに失敗した（V-1 違反・ラッパ不正・構文エラー）。 */
public class DataFileException extends RuntimeException {
    public DataFileException(String message) {
        super(message);
    }

    public DataFileException(String message, Throwable cause) {
        super(message, cause);
    }
}
