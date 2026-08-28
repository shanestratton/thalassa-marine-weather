import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    vessel: undefined as Record<string, unknown> | undefined,
    position: null as {
        latitude: number;
        longitude: number;
        accuracy: number;
        altitude: number | null;
        heading: number | null;
        speed: number;
        timestamp: number;
    } | null,
    mobState: {
        active: null,
        own: null,
        distanceMeters: null,
        bearingDeg: null,
        ownPositionAgeMs: null,
        ownPositionFresh: false,
        elapsedSec: 0,
        fixQuality: null,
        persistenceStatus: 'idle',
    } as Record<string, unknown>,
    getCurrentPosition: vi.fn(),
    mobSubscribe: vi.fn(),
    speakSafetyMessage: vi.fn(),
    prewarmSafetyMessage: vi.fn(),
    clipboardWrite: vi.fn(),
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({ settings: { vessel: mocks.vessel } }),
}));

vi.mock('../services/GpsService', () => ({
    GpsService: {
        requestCurrentForegroundPosition: (...args: unknown[]) => mocks.getCurrentPosition(...args),
        getCurrentPositionIfGranted: (...args: unknown[]) => mocks.getCurrentPosition(...args),
    },
}));

vi.mock('../hooks/useGpsHealth', () => ({
    useGpsHealth: () => null,
    gpsHealthMessage: vi.fn(),
    openDeviceSettings: vi.fn(),
}));

vi.mock('../services/MobService', () => ({
    MOB_PRECISE_FIX_ACCURACY_M: 100,
    MobService: {
        currentState: () => mocks.mobState,
        subscribe: (...args: unknown[]) => mocks.mobSubscribe(...args),
    },
}));

vi.mock('../services/voice/safetyTts', () => ({
    speakSafetyMessage: (...args: unknown[]) => mocks.speakSafetyMessage(...args),
    // Vitest THROWS on any export the factory omits, and the page reads both
    // of these. Left out, the throw lands in handleSpeak's catch and presents
    // as a button that does nothing — so the mock has to keep up with the
    // module's real surface.
    prewarmSafetyMessage: (...args: unknown[]) => mocks.prewarmSafetyMessage(...args),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { RadioConsolePage } from '../components/vessel/RadioConsolePage';
import { authScopedStorageKey } from '../services/authIdentityScope';

const CURRENT_POSITION = {
    latitude: -27.5,
    longitude: 153.5,
    accuracy: 6,
    altitude: null,
    heading: null,
    speed: 2,
    timestamp: Date.now(),
};

const MOB_SNAPSHOT = {
    fixLat: -27.25,
    fixLon: 153.125,
    fixAccuracy: 12,
    activatedAt: Date.UTC(2026, 7, 5, 3, 4),
};

/**
 * The transcript as the SKIPPER reads it.
 *
 * This used to read the argument handed to a mocked speakSafetyMessage. The
 * Speak and Copy buttons went on 2026-08-28 — "i am just not happy with the
 * voice… people will just have to read it out" — so there is no speech call
 * left to inspect.
 *
 * Asserting on the rendered text is the better test anyway. This page's whole
 * job is putting correct words in front of someone holding a handset, and now
 * these tests check the words on the screen rather than the words handed to a
 * speech engine that no longer runs.
 */
async function lastSpokenText(): Promise<string> {
    // The transcript needs the GPS fix before it says anything. The old tests
    // waited by polling the Speak button's disabled state; with the button
    // gone, wait on the thing actually being asserted.
    await waitFor(() => expect(screen.getByTestId('dsc-transcript').textContent).not.toBe('Awaiting GPS…'));
    return screen.getByTestId('dsc-transcript').textContent ?? '';
}

async function renderWithFix() {
    render(<RadioConsolePage onBack={vi.fn()} onNavigate={vi.fn()} />);
}

describe('RadioConsole emergency transcript honesty', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        mocks.vessel = undefined;
        mocks.position = { ...CURRENT_POSITION, timestamp: Date.now() };
        mocks.mobState = {
            active: null,
            own: null,
            distanceMeters: null,
            bearingDeg: null,
            ownPositionAgeMs: null,
            ownPositionFresh: false,
            elapsedSec: 0,
            fixQuality: null,
            persistenceStatus: 'idle',
        };
        mocks.getCurrentPosition.mockImplementation(async () => mocks.position);
        mocks.mobSubscribe.mockReturnValue(vi.fn());
        mocks.speakSafetyMessage.mockReturnValue({
            done: Promise.resolve(),
            cancel: vi.fn(),
            engineUsed: () => 'none',
        });
        mocks.clipboardWrite.mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: mocks.clipboardWrite },
        });
    });

    afterEach(() => cleanup());

    it('prompts a crew member to say an unset vessel name in routine, Pan-Pan, and Mayday scripts', async () => {
        mocks.vessel = {
            name: 'Not Set',
            callSign: 'Not configured',
            mmsi: 'N/A',
            phoneticName: 'Unset',
        };
        await renderWithFix();

        expect(await lastSpokenText()).toContain('Say your vessel name now');
        expect(await lastSpokenText()).not.toMatch(/Thalassa|Not Set|Course 0/i);

        fireEvent.click(screen.getByRole('button', { name: /Urgency/i }));
        expect(await lastSpokenText()).toContain('Say your vessel name three times now');
        expect(await lastSpokenText()).not.toMatch(/Thalassa|Not Set/i);

        fireEvent.click(screen.getByRole('button', { name: /Distress/i }));
        expect(await lastSpokenText()).toContain('Say your vessel name three times now');
        expect(await lastSpokenText()).toContain('Say your vessel name once now');
        expect(await lastSpokenText()).not.toMatch(/Thalassa|Not Set/i);
        // The clipboard copy that used to be checked here is gone with the
        // Copy button; the transcript assertions above already cover the same
        // ground, on the surface the skipper actually reads from.
    });

    it('omits unavailable COG while preserving a real due-north course of zero', async () => {
        mocks.vessel = { name: 'True North', type: 'sail' };
        await renderWithFix();

        // No heading available: the script must not mention a course at all
        // rather than reading a placeholder as a real bearing.
        expect(await lastSpokenText()).not.toMatch(/Course/i);

        cleanup();
        vi.clearAllMocks();
        mocks.position = { ...CURRENT_POSITION, heading: 0, timestamp: Date.now() };
        mocks.getCurrentPosition.mockImplementation(async () => mocks.position);
        mocks.mobSubscribe.mockReturnValue(vi.fn());
        mocks.speakSafetyMessage.mockReturnValue({
            done: Promise.resolve(),
            cancel: vi.fn(),
            engineUsed: () => 'none',
        });
        render(<RadioConsolePage onBack={vi.fn()} />);
        // The subject is that a REAL due-north course survives rather than
        // being dropped as "missing". Bearings are now spelled and padded to
        // three figures like every other number in a position report.
        expect(await lastSpokenText()).toContain('Course. 0, 0, 0, degrees true');
    });

    it('uses motor-vessel wording for power-vessel radio scripts', async () => {
        mocks.vessel = { name: 'Rescue One', type: 'power' };
        await renderWithFix();

        fireEvent.click(screen.getByRole('button', { name: /Distress/i }));

        expect(await lastSpokenText()).toContain('This is motor vessel Rescue One');
        expect(await lastSpokenText()).not.toContain('sailing vessel Rescue One');
    });

    it('keeps the handed-off MOB datum/time distinct from the moved vessel position', async () => {
        mocks.vessel = { name: 'Rescue One', type: 'power' };
        localStorage.setItem(
            authScopedStorageKey('thalassa_dsc_intent'),
            JSON.stringify({ version: 1, kind: 'distress-mob', snapshot: MOB_SNAPSHOT }),
        );

        await renderWithFix();
        const datumCard = (await screen.findByText(/MOB datum · not current vessel position/i)).parentElement;
        expect(datumCard).toHaveTextContent('27°15.000′S 153°7.500′E');
        expect(datumCard).toHaveTextContent('Marked 03:04:00 UTC');

        const transcript = await lastSpokenText();
        // The subject is that the two positions stay DISTINCT — the datum
        // where the person went in, and where the vessel is now. Both are
        // spoken at writing speed since 2026-08-28; the minutes and the
        // datum time are spelled out rather than read as numbers.
        expect(transcript).toContain('Current vessel position. 2, 7, degrees. 3, 0, decimal, 0, minutes. South');
        expect(transcript).toContain('Man Overboard datum. 2, 7, degrees. 1, 5, decimal, 0, minutes. South');
        expect(transcript).toContain('MOB marked at 0, 3, 0, 4, U T C');
        // Still two different latitudes, which is the whole point of the test.
        expect(transcript).not.toContain('Man Overboard datum. 2, 7, degrees. 3, 0, decimal, 0, minutes. South');
    });
});
