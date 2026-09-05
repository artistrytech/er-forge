package erd.web;

import java.util.Locale;

/**
 * HTTP レベルの共通ガード（§8.5）。
 *
 * <p>{@link WebServer} の {@code authorized} と MCP のガード（§8.8）の両方から使うため、
 * ここに切り出している。<b>規則を 1 か所にしか置かない</b>ことが目的であり、
 * 経路ごとに違う判定を書き始めると「どちらが正か分からない」状態になる。
 */
final class Guards {

    /**
     * {@code Host} ヘッダのホスト名がループバックを指しているか（DNS リバインディング対策）。
     *
     * <p>攻撃者は自分のドメインを {@code 127.0.0.1} に解決させることで、被害者のブラウザから
     * ローカルサーバーへ到達できる。そのとき {@code Host} には<b>攻撃者のドメイン</b>が載るため、
     * ここで弾く。{@code Origin} 検証だけでは、{@code Origin} を送らない経路が素通りになる。
     *
     * <p><b>判定はホスト名だけで行い、ポートは見ない。</b> 開発時の vite dev サーバーは
     * {@code changeOrigin: false} でプロキシしており（{@code viewer/vite.config.ts}）、
     * Java サーバーに届く {@code Host} は<b>元の {@code localhost:5173} のまま</b>である。
     * 「自分のポートと完全一致」で判定すると dev 環境が丸ごと動かなくなる。
     */
    static boolean isLocalHost(String hostHeader) {
        if (hostHeader == null || hostHeader.isEmpty()) return false;
        String name = hostName(hostHeader).toLowerCase(Locale.ROOT);
        return name.equals("127.0.0.1")
                || name.equals("localhost")
                || name.equals("::1");
    }

    /** {@code host:port} / {@code [v6]:port} からホスト名だけを取り出す（角括弧は外す）。 */
    private static String hostName(String hostHeader) {
        String h = hostHeader.trim();
        if (h.startsWith("[")) {
            int close = h.indexOf(']');
            return close < 0 ? h.substring(1) : h.substring(1, close);
        }
        int colon = h.indexOf(':');
        return colon < 0 ? h : h.substring(0, colon);
    }

    private Guards() { }
}
