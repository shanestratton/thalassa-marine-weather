import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FOLLOW_IDLE_MAX_AGE_MS, isStaleLocalFollow } from '../stores/followRouteStore';

/**
 * A followed route with no recording behind it is a leftover, not a passage
 * (Shane 2026-09-09: a day-old "Sail it" kept its green flag at Lady Musgrave).
 * Under way, the follow is the passage and is never aged out by this rule.
 */
const NOW = Date.parse('2026-09-09T06:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('isStaleLocalFollow', () => {
    it('drops a day-old follow that has no track behind it', () => {
        expect(FOLLOW_IDLE_MAX_AGE_MS).toBe(24 * 3600_000);
        expect(
            isStaleLocalFollow({ isFollowing: true, startedAt: ago(30 * 3600_000), lastRefresh: null }, false, NOW),
        ).toBe(true);
    });

    it('keeps a fresh follow, and any follow while a track is recording', () => {
        expect(isStaleLocalFollow({ isFollowing: true, startedAt: ago(3600_000), lastRefresh: null }, false, NOW)).toBe(
            false,
        );
        expect(
            isStaleLocalFollow({ isFollowing: true, startedAt: ago(5 * 86_400_000), lastRefresh: null }, true, NOW),
        ).toBe(false);
    });

    it('a route refresh counts as life — a multi-day passage that refreshes is not stale', () => {
        expect(
            isStaleLocalFollow(
                { isFollowing: true, startedAt: ago(3 * 86_400_000), lastRefresh: ago(3600_000) },
                false,
                NOW,
            ),
        ).toBe(false);
    });

    it('nothing to drop when not following; a follow with no dates at all is dropped', () => {
        expect(isStaleLocalFollow({ isFollowing: false, startedAt: null, lastRefresh: null }, false, NOW)).toBe(false);
        expect(isStaleLocalFollow({ isFollowing: true, startedAt: null, lastRefresh: null }, false, NOW)).toBe(true);
    });

    it('the Ship’s Log applies it at boot, and the chart asks before stopping', () => {
        const shiplog = readFileSync('services/ShipLogService.ts', 'utf8');
        expect(shiplog).toContain('isStaleLocalFollow(follow, this.trackingState.isTracking)');
        const mapHub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(mapHub).toContain(
            'useDestinationFlag(mapRef, mapReady && !planningSurface && passageOverlay, { onTap: () => setStopFollowAsk(true) })',
        );
        expect(mapHub).toContain('confirmLabel="Stop following"');
        expect(mapHub).toContain('cancelLabel="Keep following"');
    });
});
