package erd.web;

import java.time.Instant;
import java.util.UUID;

/**
 * 編集ロック（H-11 / §8.7）。プロジェクト全体で1つ。サーバーのメモリのみに保持する
 * （再起動で消える）。heartbeat が {@link #EXPIRY_MS} 途絶えたら自動失効する。
 */
public final class LockManager {

    public static final long EXPIRY_MS = 60_000;

    /** 取得結果。acquired=false のときは保持者情報を返す（423 の応答に使う）。 */
    public record Acquire(boolean acquired, String lockId, Instant acquiredAt, Instant lastHeartbeat) {}

    private String lockId;
    private Instant acquiredAt;
    private Instant lastHeartbeat;

    public synchronized Acquire acquire(boolean force) {
        expireIfStale();
        if (lockId != null && !force) {
            return new Acquire(false, null, acquiredAt, lastHeartbeat);
        }
        // 強制取得を許す（開いたまま忘れたタブに締め出される方が実害が大きい）。
        // 奪われた側は次の heartbeat の失敗（409）で降格を検知する
        lockId = "l-" + UUID.randomUUID();
        acquiredAt = Instant.now();
        lastHeartbeat = acquiredAt;
        return new Acquire(true, lockId, acquiredAt, lastHeartbeat);
    }

    /** heartbeat（15秒間隔想定）。false = ロックを失っている（失効 or 強制取得された）。 */
    public synchronized boolean heartbeat(String id) {
        expireIfStale();
        if (id == null || !id.equals(lockId)) return false;
        lastHeartbeat = Instant.now();
        return true;
    }

    /** 書き込み API のガード。有効なら heartbeat も兼ねる。 */
    public synchronized boolean isValid(String id) {
        return heartbeat(id);
    }

    public synchronized void release(String id) {
        if (id != null && id.equals(lockId)) {
            lockId = null;
            acquiredAt = null;
            lastHeartbeat = null;
        }
    }

    private void expireIfStale() {
        if (lockId != null && lastHeartbeat != null
                && Instant.now().toEpochMilli() - lastHeartbeat.toEpochMilli() > EXPIRY_MS) {
            lockId = null;
            acquiredAt = null;
            lastHeartbeat = null;
        }
    }
}
