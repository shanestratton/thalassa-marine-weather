/**
 * The shore watch must never go quietly blind.
 *
 * Shane 2026-09-04: "occasionally it will not reconnect." Traced to two faults
 * that only kill together, which is why it was "occasionally":
 *
 *   1. channel.subscribe's callback is PERMANENT in realtime-js, but the join
 *      promise's `settled` guard swallowed every post-join CHANNEL_ERROR /
 *      CLOSED / TIMED_OUT. `connected` stayed true over a dead channel — and
 *      stale-true `connected` independently vetoes all five recovery routes
 *      (foreground, online, appStateChange, restoreSession, and the backoff
 *      timer's own body).
 *
 *   2. The 20s silence watchdog was the last net, and it was ONE-SHOT per
 *      episode, re-armed only by hearing the peer — which joinChannel never
 *      did. So a rejoin that restored the channel but not the data flow (a
 *      lapsed Pi lease, a rebooted Pi) spent the only shot and left the
 *      watchdog watching a dead link in silence until morning.
 *
 * Source-pinned on purpose: these are timer and callback lifetimes across a
 * websocket, and the honest way to hold them is to assert the shape that makes
 * the failure impossible.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sync = readFileSync('services/AnchorWatchSyncService.ts', 'utf8');
const page = readFileSync('components/AnchorWatchPage.tsx', 'utf8');

describe('a dead channel is noticed', () => {
    it('post-join status changes reach recovery instead of being swallowed', () => {
        expect(sync).toMatch(/if \(!settled\) \{\s*finish\(nextStatus\);\s*return;\s*\}/);
        expect(sync).toMatch(/this\.handleConnectionLost\(`channel_\$\{nextStatus\.toLowerCase\(\)\}`\)/);
    });

    it('the identity fence runs on EVERY invocation, not just the join', () => {
        // Tighter than before, not looser: a superseded channel used to be
        // discarded by luck (the settled guard), now by the identity check.
        const cb = sync.slice(
            sync.indexOf('channel.subscribe((nextStatus'),
            sync.indexOf('});', sync.indexOf('channel.subscribe((nextStatus')),
        );
        const fence = cb.indexOf('isConnectionCurrent');
        const settled = cb.indexOf('if (!settled)');
        expect(fence).toBeGreaterThan(-1);
        expect(settled).toBeGreaterThan(fence);
    });

    it('losing the link clears `connected`, which is what gates every recovery path', () => {
        const fn = sync.slice(sync.indexOf('private handleConnectionLost'), sync.indexOf('private scheduleReconnect'));
        expect(fn).toMatch(/this\.connected = false;/);
        expect(fn).toMatch(/this\.notifyState\(\);/);
        expect(fn).toMatch(/this\.scheduleReconnect\(\);/);
        // log.warn, not info: info is compiled out of production iOS builds,
        // so an info() here would be invisible on the device that failed.
        expect(fn).toMatch(/log\.warn\(/);
        expect(fn).not.toMatch(/log\.info\(/);
    });
});

describe('the silence ladder', () => {
    it('rejoins repeatedly on an escalating budget, never once', () => {
        expect(sync).not.toMatch(/this\.rejoinedOnSilence/);
        expect(sync).toMatch(/Math\.min\(20000 \* Math\.pow\(2, this\.silenceRejoins\), 300000\)/);
        expect(sync).toMatch(/this\.silenceRejoins\+\+;/);
    });

    it('a fresh channel re-arms the watchdog, which joinChannel never did', () => {
        expect(sync).toMatch(/if \(this\.lastPeerUpdate === null\) this\.lastPeerUpdate = Date\.now\(\);/);
        // `=== null` deliberately: a rejoin must not reset a genuinely stale
        // timestamp, or the escalation would be reset by its own recovery
        // attempt and could never climb.
        expect(sync).not.toMatch(/this\.lastPeerUpdate = Date\.now\(\); \/\/ unconditional/);
    });

    it('escalates past rejoining to re-probing the Pi, because a rejoin cannot fix a lapsed lease', () => {
        expect(sync).toMatch(/void this\.reprobeVesselKeeper\(/);
        expect(sync).toMatch(/AnchorPiWatchKeeper\.renewNow\(\)/);
    });

    it('the 30s vessel-lost warning is no longer dead code for a Pi-kept watch', () => {
        // It used to be gated on `&& this.peerConnected`. The Pi never joins
        // Realtime, so presence never sets that true — the warning could never
        // fire for exactly the setup being hardened.
        expect(sync).toMatch(/silentMs > 30000 && this\.peerDisconnectedAt === null/);
        expect(sync).not.toMatch(/silentMs > 30000 && this\.peerConnected/);
    });
});

describe('the shore page', () => {
    it('does NOT demolish the session after 60 silent seconds', () => {
        // leaveSession() erased the saved code AND this device's row in
        // anchor_alarm_tokens — its registration for drag pushes — over a
        // transient gap, while the reconnect ladder was still climbing.
        // Scoped to the effect BODY, past the comment that explains what was
        // removed — a slice starting at the comment reads the word
        // "leaveSession()" in the explanation and fails on the prose.
        const from = page.indexOf('A TIMEOUT IS A REASON TO WARN');
        expect(from).toBeGreaterThan(-1);
        const effect = page.slice(page.indexOf('useEffect(() => {', from), page.indexOf('// Shore alarm', from));
        expect(effect.length).toBeGreaterThan(0);
        expect(effect).not.toMatch(/leaveSession\(\)/);
        expect(effect).toMatch(/log\.warn\(/);
    });
});
