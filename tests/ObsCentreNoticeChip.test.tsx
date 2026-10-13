/**
 * The one calm line Obs shows when what the location box follows has no live
 * fix (Shane 2026-10-06: "the last known location with a clear message telling
 * them that").
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/GpsService', () => ({
    GpsService: { getLastKnownPosition: () => null, getCurrentPositionIfGranted: vi.fn(async () => null) },
}));
vi.mock('../stores/LocationStore', () => ({
    LocationStore: { getState: () => ({ source: 'initial' }), subscribe: () => () => {} },
}));
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: () => ({}), subscribe: () => () => {} } }));

import { ObsCentreNoticeChip, obsNoticeStackedTop } from '../components/map/ObsCentreNoticeChip';
import { __resetObsCentreForTests, getObsCentreNotice, showObsCentreNotice } from '../components/map/obsCentre';

const NOW = Date.parse('2026-10-06T02:00:00.000Z');
const NAMES = { own: 'Serene Summer', crew: null };

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    __resetObsCentreForTests();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('ObsCentreNoticeChip', () => {
    it('keeps an empty live region mounted, so the first message is spoken', () => {
        render(<ObsCentreNoticeChip visible names={NAMES} />);
        const status = screen.getByRole('status');
        expect(status).toHaveTextContent('');
        expect(status).toHaveAttribute('aria-live', 'polite');
        act(() => {
            showObsCentreNotice({
                subject: { kind: 'boat', crewOwnerId: null },
                state: 'held',
                at: NOW - 3 * 3_600_000,
            });
        });
        expect(screen.getByRole('status')).toBe(status);
        expect(status).toHaveTextContent("Showing Serene Summer's last known position · 3 h ago");
    });

    it('keeps the age current while it shows', () => {
        showObsCentreNotice({ subject: { kind: 'phone' }, state: 'held', at: NOW - 59 * 60_000 });
        render(<ObsCentreNoticeChip visible names={NAMES} />);
        expect(screen.getByRole('status')).toHaveTextContent('showing where you were 59 min ago');
        act(() => vi.advanceTimersByTime(60_000));
        expect(screen.getByRole('status')).toHaveTextContent('showing where you were 1 h ago');
    });

    it('is dismissible with a 44 px button named for what it does', () => {
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'none', at: null });
        render(<ObsCentreNoticeChip visible names={NAMES} />);
        const dismiss = screen.getByRole('button', { name: 'Dismiss position message' });
        expect(dismiss.className).toContain('h-11 w-11');
        fireEvent.click(dismiss);
        expect(getObsCentreNotice()).toBeNull();
        expect(screen.getByRole('status')).toHaveTextContent('');
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('shows nothing off Obs, but keeps its live region, so a standing message is spoken on return', () => {
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'none', at: null });
        const { rerender } = render(<ObsCentreNoticeChip visible={false} names={NAMES} />);
        const status = screen.getByRole('status');
        expect(status).toHaveTextContent('');
        expect(status.className).toBe('sr-only');
        expect(screen.queryByRole('button')).toBeNull();
        rerender(<ObsCentreNoticeChip visible names={NAMES} />);
        expect(screen.getByRole('status')).toBe(status);
        expect(status).toHaveTextContent('No position from Serene Summer yet');
    });

    // ThreatBanner (z-805) and the live-tide badge (z-9990) hold the centre
    // of the top row; the message was under them (review 2026-10-06).
    it('drops below the threat banner and the live-tide badge while they show', () => {
        expect(obsNoticeStackedTop(false, true, false)).toBe(
            'max(calc(env(safe-area-inset-top) + 64px), calc(max(58px, env(safe-area-inset-top) + 56px) + 60px))',
        );
        expect(obsNoticeStackedTop(false, false, true)).toBe('max(calc(env(safe-area-inset-top) + 64px), 116px)');
        expect(obsNoticeStackedTop(false, true, true)).toBe(
            'max(calc(env(safe-area-inset-top) + 64px), calc(max(58px, env(safe-area-inset-top) + 56px) + 60px), 116px)',
        );
        // Under Whole route (safe top + 164 px) it is already below both.
        expect(obsNoticeStackedTop(true, true, true)).toBeUndefined();
        expect(obsNoticeStackedTop(false, false, false)).toBeUndefined();
        // Applied inline (jsdom cannot parse max(), so only its presence is checked here).
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'none', at: null });
        const { container, rerender } = render(<ObsCentreNoticeChip visible names={NAMES} belowTideBadge />);
        const slot = () => container.firstElementChild as HTMLElement;
        expect(slot().getAttribute('style')).toContain('max(');
        rerender(<ObsCentreNoticeChip visible names={NAMES} belowTideBadge belowRouteButton />);
        expect(slot().getAttribute('style') ?? '').not.toContain('max(');
    });

    it('sits under the top row, inside the right rail’s gutter on a 320 px phone, in the app’s amber', () => {
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'none', at: null });
        const { container } = render(<ObsCentreNoticeChip visible names={NAMES} />);
        const slot = container.firstElementChild as HTMLElement;
        expect(slot.className).toContain('top-[calc(env(safe-area-inset-top)+64px)]');
        // 320 - 144 = 176 px for the line: clear of the 16 + 48 px rail on each side.
        expect(slot.className).toContain('w-[min(360px,calc(100%-144px))]');
        expect(slot.className).toContain('left-1/2');
        expect(slot.className).toContain('-translate-x-1/2');
        const chip = slot.firstElementChild as HTMLElement;
        expect(chip.style.background).toContain('--day-ui-amber-surface');
        expect(chip.style.color).toContain('--day-ui-amber');
        expect(chip.className).toContain('max-w-full');
        // Below the base picker's open menu (z-9998) and the threat banner (z-805).
        expect(slot.className).toContain('z-705');
    });

    // The "Whole route" button sits at safe top + 112 px on the left; a
    // wrapped line (two on a 390 px phone, four on 320) reached it.
    it('drops below the Whole route button while that button shows', () => {
        showObsCentreNotice({ subject: { kind: 'boat', crewOwnerId: null }, state: 'none', at: null });
        const { container, rerender } = render(<ObsCentreNoticeChip visible names={NAMES} belowRouteButton />);
        const slot = () => container.firstElementChild as HTMLElement;
        expect(slot().className).toContain('top-[calc(env(safe-area-inset-top)+164px)]');
        expect(slot().className).not.toContain('+64px');
        // The free left column under the button, still clear of the 16 + 48 px
        // right rail: 232 px on a 320 px phone, three lines above the vessel.
        expect(slot().className).toContain('left-4');
        expect(slot().className).toContain('right-[72px]');
        expect(slot().className).toContain('max-w-[360px]');
        expect(slot().className).not.toContain('translate');
        rerender(<ObsCentreNoticeChip visible names={NAMES} belowRouteButton={false} />);
        expect(slot().className).toContain('top-[calc(env(safe-area-inset-top)+64px)]');
        expect(slot().className).toContain('-translate-x-1/2');
    });

    it('is mounted on Obs by MapHub, and hidden during a MOB or under the full-screen consensus matrix', () => {
        const hub = readFileSync('components/map/MapHub.tsx', 'utf8');
        expect(hub).toMatch(
            /<ObsCentreNoticeChip\s+visible=\{obsShowing && !mobActive && !\(deviceMode === 'deck' && showConsensus && consensusData\)\}\s+names=\{obsBoatNames\}\s+belowRouteButton=\{passageOverviewAvailable && !overviewLocked\}\s+belowThreatBanner=\{threatBannerShowing\}\s+belowTideBadge=\{tideDepthMode\}\s+\/>/,
        );
        expect(hub).toContain('onShowingChange={setThreatBannerShowing}');
        // The Whole route button it drops below is the one at safe top + 112 px.
        expect(hub).toContain("top: 'calc(env(safe-area-inset-top) + 112px)'");
        expect(hub).toContain('useObsCentreNoticeWatch(obsShowing);');
        // On Obs only: the desk planner's wind (127-DESKMAP-b) is the forecast field alone.
        expect(hub).toContain("boatInstruments={!planningSurface && obsStart.kind === 'follow'}");
    });
});
