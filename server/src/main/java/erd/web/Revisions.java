package erd.web;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * リビジョンID の払い出しと、自己書き込みの記録（INV-3 / §8.3）。
 *
 * <p>API の書き込みには revision を割り当て、書き込んだファイルの内容ハッシュを記録する。
 * ファイル監視が変更を検知したとき、変更ファイルのハッシュがすべて記録と一致すれば
 * 「自分の書き込みが監視に引っかかっただけ」であり、その revision を SSE に載せる
 * （クライアントは自分の revision を無視して再読込ループを断つ）。
 */
public final class Revisions {

    private record SelfWrite(String hash, String revision) {}

    private final Map<String, SelfWrite> selfWrites = new ConcurrentHashMap<>();

    public String next() {
        return "r-" + UUID.randomUUID();
    }

    public String nextExternal() {
        return "ext-" + UUID.randomUUID();
    }

    /**
     * relPath は data/ からの相対パス（例: "diagrams/core.js"）。
     * contentHash が null なら「自分が削除した」ことの記録（逆生成の適用でテーブルが消える場合）。
     */
    public void recordWrite(String relPath, String contentHash, String revision) {
        selfWrites.put(relPath, new SelfWrite(contentHash, revision));
    }

    /**
     * 変更ファイル群（relPath → 現在の内容ハッシュ。削除は null）を自己書き込みに帰属できるか。
     * すべて一致すれば代表 revision を返し、1つでも不一致なら null（= 外部変更）。
     */
    public String attribute(Map<String, String> changedHashes) {
        String rev = null;
        for (Map.Entry<String, String> e : changedHashes.entrySet()) {
            SelfWrite sw = selfWrites.get(e.getKey());
            if (sw == null || !java.util.Objects.equals(sw.hash(), e.getValue())) {
                return null;
            }
            rev = sw.revision();
        }
        return rev;
    }
}
