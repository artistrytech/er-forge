package erd.core.model;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * ワークスペース（マルチデータベース構成の単位）。
 *
 * <p>実体は {@code erd/workspace-<id>/data/**}。一覧と表示名は {@code erd/workspaces.js}
 * （ツール生成物）に持ち、静的モード（file://）でも &lt;script&gt; 1本で読めるようにする。
 * 存在の正はフォルダの走査であり、レジストリは走査結果で再生成される。
 *
 * @param id   フォルダ名に使う識別子（英数・ハイフン・アンダーバー）
 * @param name 表示名（必須。空にはできない）
 */
public record Workspace(String id, String name) {

    /** フォルダ名の接頭辞。`workspace-<id>` が Windows の予約名と衝突しない根拠でもある。 */
    public static final String PREFIX = "workspace-";

    /** ID 省略時の既定。 */
    public static final String DEFAULT_ID = "default";

    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_-]{0,31}");

    /** 英数で始まり、英数・ハイフン・アンダーバーのみ。32文字まで。 */
    public static boolean isValidId(String id) {
        return id != null && ID.matcher(id).matches();
    }

    /**
     * 重複判定用の正規化。Windows はパスの大文字小文字を区別しないため、
     * {@code Sales} と {@code sales} は同一の ID として扱う。
     */
    public static String normalizeId(String id) {
        return id == null ? "" : id.toLowerCase(Locale.ROOT);
    }

    /** フォルダ名（`workspace-<id>`）。 */
    public static String folderName(String id) {
        return PREFIX + id;
    }

    /** フォルダ名から ID を取り出す（接頭辞が無い・ID が不正なら null）。 */
    public static String idFromFolder(String folderName) {
        if (folderName == null || !folderName.startsWith(PREFIX)) return null;
        String id = folderName.substring(PREFIX.length());
        return isValidId(id) ? id : null;
    }
}
