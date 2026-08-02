import { describe, it, expect, vi } from 'vitest';

/**
 * The GPS honesty rules (Shane, 2026-08-02).
 *
 * A permission denial and a cold start looked IDENTICAL — both an amber
 * "Acquiring GPS fix…" spinner — so the app sat there for hours over a problem
 * the OS had already decided. gpsHealthMessage is the single copy table every
 * acquiring surface draws on to name the cause instead of spinning.
 *
 * The GpsAcquiringOverlay takeover this file used to exercise was REMOVED
 * 2026-08-03 (Shane: keep only the Log header badge) — its says-WHY duties
 * now live on the badge via gpsHeadline, covered in tests/LogPage.test.tsx
 * ("the acquiring surfaces tell the truth").
 */

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        getLastGpsHealth: () => null,
        getGpsHealth: async () => ({ usable: true, reason: 'ok', actionable: false }),
        subscribeGpsHealth: () => () => {},
    },
}));

import { gpsHealthMessage } from '../hooks/useGpsHealth';

describe('gpsHealthMessage — every blocking cause has copy, and nothing else does', () => {
    it.each(['denied', 'not-determined', 'services-off', 'no-gps'] as const)('has copy for %s', (reason) => {
        const msg = gpsHealthMessage(reason);
        expect(msg).not.toBeNull();
        expect(msg!.title.length).toBeGreaterThan(0);
        expect(msg!.detail.length).toBeGreaterThan(0);
    });

    it('does not interrupt for states that are not the skipper’s problem', () => {
        expect(gpsHealthMessage('ok')).toBeNull();
        expect(gpsHealthMessage('unknown')).toBeNull();
    });
});
