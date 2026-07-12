package erd.core.migrate;

import erd.core.model.ProjectModel;

/**
 * データ形式の移行（Phase0 詳細設計 §6.4）。
 *
 * <p>純粋関数であること（I/O をしない。テストしやすく、ドライランできる）。
 * 冪等であること。移行関数は削除しない（古いリポジトリを開ける必要があるため）。
 * 各移行に対して golden fixture を必ず用意する。
 */
public interface Migration {
    int fromVersion();

    int toVersion();

    ProjectModel apply(ProjectModel model);

    /** GUI に出す説明（例:「カーディナリティを meta.relations に移動」）。 */
    String description();
}
