/**
 * A forgotten device must stop holding the boat's public page (build 125,
 * 125-12). Shane 2026-10-09 at the marina: "Live share is on, but iPhone/iPad
 * · 7e1a holds the skipper claim (active 32 days ago)". claimedAt is written
 * once, at takeover, so "active 32 days ago" really meant "claimed 32 days
 * ago" — and a live holder looked exactly like a dead one.
 *
 * These pin the pure rules: the holder's sign of life (lastSeenAt, else
 * claimedAt), the 6 h handover window, the 30 min heartbeat cadence, and the
 * words that say which of those we actually know.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    CLAIM_HEARTBEAT_MS,
    CLAIM_STALE_AFTER_MS,
    autoHandoverMessage,
    claimSeenPhrase,
    claimSeenShort,
    getDeviceId,
    hasBeenDisplaced,
    heartbeatDue,
    isClaimStale,
    sameClaim,
    withHeartbeat,
    type SkipperClaim,
} from '../services/skipperDevice';

const NOW = Date.parse('2026-10-09T06:15:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Fictional devices (the repo is public).
const OLD_SHAPE: SkipperClaim = {
    deviceId: 'dev-fictional-ipad-7e1a',
    deviceName: 'iPhone/iPad · 7e1a',
    claimedAt: ago(32 * DAY),
};

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope('skipper-user');
});

describe('the holder’s last sign of life', () => {
    it('treats an old claim with no heartbeat as stale on its claimedAt alone', () => {
        expect(isClaimStale(OLD_SHAPE, NOW)).toBe(true);
    });

    it('a heartbeat 20 minutes ago keeps a 40-day-old claim alive', () => {
        const fresh = { ...OLD_SHAPE, claimedAt: ago(40 * DAY), lastSeenAt: ago(20 * MIN) };
        expect(isClaimStale(fresh, NOW)).toBe(false);
    });

    it('goes stale only past six hours with no sign of life', () => {
        expect(CLAIM_STALE_AFTER_MS).toBe(6 * HOUR);
        expect(isClaimStale({ ...OLD_SHAPE, lastSeenAt: ago(6 * HOUR - MIN) }, NOW)).toBe(false);
        expect(isClaimStale({ ...OLD_SHAPE, lastSeenAt: ago(6 * HOUR + MIN) }, NOW)).toBe(true);
        // A fresh claim that has not published yet is not stale either.
        expect(isClaimStale({ ...OLD_SHAPE, claimedAt: ago(10 * MIN) }, NOW)).toBe(false);
    });

    it('counts another sign of life the caller found (the account’s newest live point)', () => {
        expect(isClaimStale(OLD_SHAPE, NOW, NOW - HOUR)).toBe(false);
        expect(isClaimStale(OLD_SHAPE, NOW, NOW - 7 * HOUR)).toBe(true);
    });

    it('never calls a missing claim stale — an unclaimed boat publishes freely', () => {
        expect(isClaimStale(null, NOW)).toBe(false);
        expect(isClaimStale(undefined, NOW)).toBe(false);
    });
});

describe('the heartbeat cadence', () => {
    const mine = (lastSeenAt?: string): SkipperClaim => ({
        deviceId: getDeviceId(),
        deviceName: 'iPhone · 9f3a',
        claimedAt: ago(3 * DAY),
        ...(lastSeenAt ? { lastSeenAt } : {}),
    });

    it('is due for a held claim that has never published, or not for 30 minutes', () => {
        expect(CLAIM_HEARTBEAT_MS).toBe(30 * MIN);
        expect(heartbeatDue(mine(), NOW)).toBe(true);
        expect(heartbeatDue(mine(ago(20 * MIN)), NOW)).toBe(false);
        expect(heartbeatDue(mine(ago(31 * MIN)), NOW)).toBe(true);
        // A claim made minutes ago is its own sign of life: no write straight
        // after the takeover that made it.
        expect(heartbeatDue({ ...mine(), claimedAt: ago(5 * MIN) }, NOW)).toBe(false);
    });

    it('is never due for a claim held elsewhere, or for no claim at all', () => {
        expect(heartbeatDue(OLD_SHAPE, NOW)).toBe(false);
        expect(heartbeatDue(null, NOW)).toBe(false);
    });

    it('stamps lastSeenAt and keeps who claimed it and when', () => {
        const claim = mine();
        const beat = withHeartbeat(claim, NOW);
        expect(beat.deviceId).toBe(claim.deviceId);
        expect(beat.claimedAt).toBe(claim.claimedAt);
        expect(beat.lastSeenAt).toBe(new Date(NOW).toISOString());
        expect(sameClaim(beat, claim)).toBe(false);
        expect(sameClaim(beat, { ...beat })).toBe(true);
    });
});

describe('honest last-seen words', () => {
    it('says "last published" only when the holder actually published', () => {
        expect(claimSeenPhrase({ ...OLD_SHAPE, lastSeenAt: ago(2 * HOUR) }, NOW)).toBe('last published 2 hours ago');
        expect(claimSeenShort({ ...OLD_SHAPE, lastSeenAt: ago(2 * HOUR) }, NOW)).toBe('published 2 hours ago');
    });

    it('says only "claimed …" for a claim with no heartbeat — never "no sign of it since"', () => {
        // A holder on an older build publishes without a heartbeat, so the
        // claim alone cannot say it went quiet (only the trickle's live-track
        // check can, and then it takes over and says so).
        expect(claimSeenPhrase(OLD_SHAPE, NOW)).toBe('claimed 32 days ago');
        expect(claimSeenShort(OLD_SHAPE, NOW)).toBe('claimed 32 days ago');
        expect(claimSeenPhrase({ ...OLD_SHAPE, claimedAt: ago(5 * MIN) }, NOW)).toBe('claimed 5 minutes ago');
        expect(claimSeenPhrase({ ...OLD_SHAPE, claimedAt: 'not a date' }, NOW)).toBe('claimed at an unknown time');
    });

    it('announces an automatic handover once, plainly, naming the old holder', () => {
        // Old shape: we only know when it claimed, so "hadn't been seen".
        expect(autoHandoverMessage(OLD_SHAPE, NOW)).toMatch(
            /^Publishing from this (phone|iPad|device|browser) now\. iPhone\/iPad · 7e1a hadn’t been seen for 32 days\.$/,
        );
        // With a heartbeat we know it stopped publishing.
        expect(
            autoHandoverMessage({ ...OLD_SHAPE, deviceName: 'iPad · 77c1', lastSeenAt: ago(7 * HOUR) }, NOW),
        ).toMatch(/now\. iPad · 77c1 hadn’t published for 7 hours\.$/);
    });

    it('measures the silence from the newest sign of life, the account’s live track included', () => {
        // A 32-day-old claim, but the account's newest live point is 7 hours
        // old (an older build published until then): 7 hours, not 32 days.
        expect(autoHandoverMessage(OLD_SHAPE, NOW, NOW - 7 * HOUR)).toMatch(
            /now\. iPhone\/iPad · 7e1a hadn’t published for 7 hours\.$/,
        );
        // The heartbeat is newer than the live point: the heartbeat counts.
        expect(autoHandoverMessage({ ...OLD_SHAPE, lastSeenAt: ago(8 * HOUR) }, NOW, NOW - 3 * DAY)).toMatch(
            /hadn’t published for 8 hours\.$/,
        );
        // A live point older than the claim: the claim was the last sign.
        expect(autoHandoverMessage({ ...OLD_SHAPE, claimedAt: ago(9 * HOUR) }, NOW, NOW - 3 * DAY)).toMatch(
            /hadn’t been seen for 9 hours\.$/,
        );
        // No rows at all on the account: the claim's age, as before.
        expect(autoHandoverMessage(OLD_SHAPE, NOW, null)).toMatch(/hadn’t been seen for 32 days\.$/);
    });
});

describe('the displaced device still finds out', () => {
    it('a device that held the claim learns it was taken over automatically', () => {
        const takenBy: SkipperClaim = {
            deviceId: 'dev-fictional-iphone-9f3a',
            deviceName: 'iPhone · 9f3a',
            claimedAt: ago(0),
        };
        expect(hasBeenDisplaced(takenBy, true)).toBe(true);
        expect(hasBeenDisplaced(takenBy, false)).toBe(false);
    });
});
