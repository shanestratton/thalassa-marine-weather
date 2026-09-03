/**
 * probePiWatchCapability — the link that actually broke.
 *
 * The probe used to start with resolvePiWatchTarget(), which returns null
 * unless piCache's CACHED status already says `reachable`. On Shane's iPhone
 * that mirror was false from 14:10 on 2026-09-03 onward, so the probe returned
 * capable:false without sending a single packet — while curl to the same Pi
 * answered {"capable":true}. Six fixes moved the offer around inside
 * AnchorWatchPage and none of them could matter.
 *
 * This asserts the behaviour that makes that impossible again: a stale/false
 * mirror must NOT stop the app asking the Pi.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getStatus = vi.fn();
const getBaseUrl = vi.fn();
const pinnedPiRequest = vi.fn();

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getStatus: () => getStatus(),
        getBaseUrl: () => getBaseUrl(),
        ping: vi.fn().mockResolvedValue({}),
    },
}));
vi.mock('../services/PiPairingService', () => ({
    pinnedPiRequest: (o: unknown) => pinnedPiRequest(o),
}));
vi.mock('../services/anchorPiHandoff', () => ({
    clearWatchOnPi: vi.fn(),
    handOffToPi: vi.fn(),
    RENEW_INTERVAL_MS: 60_000,
}));

import { probePiWatchCapability } from '../services/anchorPiWatchKeeper';

describe('probePiWatchCapability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getBaseUrl.mockReturnValue('https://192.168.1.180:3001');
        pinnedPiRequest.mockResolvedValue({
            status: 200,
            data: JSON.stringify({ capable: true, paired: true, hasFix: true, reason: null }),
        });
    });

    it('ASKS THE PI even when the cached status says the Pi is unreachable', async () => {
        getStatus.mockReturnValue({ reachable: false, lastCheck: 0, latencyMs: 0 });
        const cap = await probePiWatchCapability();
        expect(pinnedPiRequest).toHaveBeenCalledTimes(1);
        expect(vi.mocked(pinnedPiRequest).mock.calls[0][0]).toMatchObject({
            url: 'https://192.168.1.180:3001/api/anchor/capability',
        });
        expect(cap.capable).toBe(true);
    });

    it('asks even when the cached status carries no diaryRelayId', async () => {
        getStatus.mockReturnValue({ reachable: true, lastCheck: 0, latencyMs: 0, diaryRelayId: undefined });
        const cap = await probePiWatchCapability();
        expect(pinnedPiRequest).toHaveBeenCalledTimes(1);
        expect(cap.capable).toBe(true);
    });

    it('carries the Pi’s own reason back so the deck can see WHY', async () => {
        getStatus.mockReturnValue({ reachable: true, lastCheck: 0, latencyMs: 0, diaryRelayId: 'pi_x' });
        pinnedPiRequest.mockResolvedValue({
            status: 200,
            data: JSON.stringify({
                capable: false,
                paired: true,
                hasFix: false,
                reason: 'Signal K on this Pi cannot see the vessel right now',
            }),
        });
        const cap = await probePiWatchCapability();
        expect(cap.capable).toBe(false);
        expect(cap.reason).toBe('Signal K on this Pi cannot see the vessel right now');
    });

    it('never returns a null reason on a failure the skipper could act on', async () => {
        getStatus.mockReturnValue({ reachable: true, lastCheck: 0, latencyMs: 0, diaryRelayId: 'pi_x' });
        pinnedPiRequest.mockRejectedValue(new Error('Refusing /api/anchor/capability without a pinned key'));
        const cap = await probePiWatchCapability();
        expect(cap.capable).toBe(false);
        expect(cap.reason).toMatch(/pinned key/);
    });

    it('says so plainly when there is no Pi host at all', async () => {
        getStatus.mockReturnValue({ reachable: false, lastCheck: 0, latencyMs: 0 });
        getBaseUrl.mockReturnValue(null);
        const cap = await probePiWatchCapability();
        expect(pinnedPiRequest).not.toHaveBeenCalled();
        expect(cap.reason).toBe('No Pi is set up on this phone yet');
    });
});
