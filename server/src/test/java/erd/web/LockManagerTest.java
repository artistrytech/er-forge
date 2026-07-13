package erd.web;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LockManagerTest {

    @Test
    void acquireAndConflict() {
        LockManager lm = new LockManager();
        LockManager.Acquire a = lm.acquire(false);
        assertTrue(a.acquired());

        // 2本目は取得できず、保持者情報が返る（T-12）
        LockManager.Acquire b = lm.acquire(false);
        assertFalse(b.acquired());

        // 強制取得はできる。元の保持者の heartbeat は失敗する（降格を検知する）
        LockManager.Acquire c = lm.acquire(true);
        assertTrue(c.acquired());
        assertNotEquals(a.lockId(), c.lockId());
        assertFalse(lm.heartbeat(a.lockId()));
        assertTrue(lm.heartbeat(c.lockId()));
    }

    @Test
    void releaseAndReacquire() {
        LockManager lm = new LockManager();
        LockManager.Acquire a = lm.acquire(false);
        lm.release(a.lockId());
        assertFalse(lm.heartbeat(a.lockId()));
        assertTrue(lm.acquire(false).acquired());
    }

    @Test
    void unknownIdIsInvalid() {
        LockManager lm = new LockManager();
        lm.acquire(false);
        assertFalse(lm.isValid("l-nope"));
        assertFalse(lm.isValid(null));
    }
}
