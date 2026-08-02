import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The two GPS honesty gaps (Shane, 2026-08-02).
 *
 * A permission denial and a cold start looked IDENTICAL — both an amber
 * "Acquiring GPS fix…" spinner — so the app sat there for hours over a problem
 * the OS had already decided. On the DSC/MOB radio screen it was worse: the
 * "No Fix" state was unreachable dead code, because GpsService.getCurrentPosition
 * resolves null rather than rejecting, and the error state was only set from a
 * rejection. That screen is where a skipper reads a position onto a distress
 * call.
 */

const h = vi.hoisted(() => ({
    health: { usable: true, reason: 'ok', actionable: false } as {
        usable: boolean;
        reason: string;
        actionable: boolean;
    },
    healthListeners: new Set<(x: unknown) => void>(),
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        getLastGpsHealth: () => null,
        getGpsHealth: async () => h.health,
        subscribeGpsHealth: (cb: (x: unknown) => void) => {
            h.healthListeners.add(cb);
            return () => h.healthListeners.delete(cb);
        },
    },
}));

vi.mock('../hooks/useFocusTrap', () => ({ useFocusTrap: () => ({ current: null }) }));
vi.mock('../components/ui/OverlayPortal', () => ({
    OverlayPortal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    OVERLAY_Z_INDEX: { critical: 10000 },
    NIGHT_SCRIM_Z_INDEX: 9000,
}));

import { GpsAcquiringOverlay } from '../components/ui/GpsAcquiringOverlay';
import { gpsHealthMessage } from '../hooks/useGpsHealth';

beforeEach(() => {
    vi.clearAllMocks();
    h.healthListeners.clear();
    h.health = { usable: true, reason: 'ok', actionable: false };
});

describe('GpsAcquiringOverlay — says WHY, not just that it is waiting', () => {
    it('shows the ordinary acquiring state when the GPS is genuinely usable', async () => {
        render(<GpsAcquiringOverlay open onDismiss={vi.fn()} />);
        expect(await screen.findByText('Acquiring GPS fix…')).toBeInTheDocument();
        // No settings escape offered for a problem the skipper cannot fix.
        expect(screen.queryByRole('button', { name: 'Open Settings' })).not.toBeInTheDocument();
    });

    it.each([
        ['denied', 'Location access is off'],
        ['services-off', 'Location Services are switched off'],
        ['not-determined', 'Location access not granted yet'],
    ])('names the cause instead of spinning when permission is %s', async (reason, title) => {
        h.health = { usable: false, reason, actionable: true };
        render(<GpsAcquiringOverlay open onDismiss={vi.fn()} />);

        expect(await screen.findByText(title)).toBeInTheDocument();
        expect(screen.queryByText('Acquiring GPS fix…')).not.toBeInTheDocument();
        // And a way out — this is fixable in Settings, so offer it.
        expect(screen.getByRole('button', { name: 'Open Settings' })).toBeInTheDocument();
    });

    it('tells the skipper nothing is being recorded — the part that actually costs them', async () => {
        h.health = { usable: false, reason: 'denied', actionable: true };
        render(<GpsAcquiringOverlay open onDismiss={vi.fn()} />);
        expect(await screen.findByText(/Nothing is being recorded/i)).toBeInTheDocument();
    });

    it('offers no Settings escape for a cause Settings cannot fix', async () => {
        h.health = { usable: false, reason: 'no-gps', actionable: false };
        render(<GpsAcquiringOverlay open onDismiss={vi.fn()} />);
        expect(await screen.findByText('No GPS available')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Open Settings' })).not.toBeInTheDocument();
    });

    it('counts the wait out loud — a counter cannot lie', async () => {
        render(<GpsAcquiringOverlay open onDismiss={vi.fn()} />);
        expect(await screen.findByText(/Searching 0:00/)).toBeInTheDocument();
    });

    it('renders nothing when closed', () => {
        const { container } = render(<GpsAcquiringOverlay open={false} onDismiss={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
    });
});

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
