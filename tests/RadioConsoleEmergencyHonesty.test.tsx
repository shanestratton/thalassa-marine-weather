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

function lastSpokenText(): string {
    return String(mocks.speakSafetyMessage.mock.calls.at(-1)?.[0] ?? '');
}

async function renderWithFix() {
    render(<RadioConsolePage onBack={vi.fn()} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Speak transcript aloud' })).toBeEnabled());
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

        fireEvent.click(screen.getByRole('button', { name: 'Speak transcript aloud' }));
        expect(lastSpokenText()).toContain('Say your vessel name now');
        expect(lastSpokenText()).not.toMatch(/Thalassa|Not Set|Course 0/i);

        fireEvent.click(screen.getByRole('button', { name: /Urgency/i }));
        fireEvent.click(screen.getByRole('button', { name: 'Speak transcript aloud' }));
        expect(lastSpokenText()).toContain('Say your vessel name three times now');
        expect(lastSpokenText()).not.toMatch(/Thalassa|Not Set/i);

        fireEvent.click(screen.getByRole('button', { name: /Distress/i }));
        fireEvent.click(screen.getByRole('button', { name: 'Speak transcript aloud' }));
        expect(lastSpokenText()).toContain('Say your vessel name three times now');
        expect(lastSpokenText()).toContain('Say your vessel name once now');
        expect(lastSpokenText()).not.toMatch(/Thalassa|Not Set/i);
        fireEvent.click(screen.getByRole('button', { name: 'Copy transcript to clipboard' }));
        await waitFor(() => expect(mocks.clipboardWrite).toHaveBeenCalled());
        expect(String(mocks.clipboardWrite.mock.calls.at(-1)?.[0])).not.toMatch(
            /Thalassa|Not Set|Not configured|N\/A/i,
        );
    });

    it('omits unavailable COG while preserving a real due-north course of zero', async () => {
        mocks.vessel = { name: 'True North', type: 'sail' };
        await renderWithFix();

        fireEvent.click(screen.getByRole('button', { name: 'Speak transcript aloud' }));
        expect(lastSpokenText()).not.toContain('Course 0 degrees true');
        fireEvent.click(screen.getByRole('button', { name: 'Copy transcript to clipboard' }));
        await waitFor(() => expect(mocks.clipboardWrite).toHaveBeenCalled());
        expect(String(mocks.clipboardWrite.mock.calls[0]?.[0])).not.toContain('COG: 0°T');
        expect(String(mocks.clipboardWrite.mock.calls[0]?.[0])).not.toContain('COG:');

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
        await waitFor(() => expect(screen.getByRole('button', { name: 'Speak transcript aloud' })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: 'Speak transcript aloud' }));
        expect(lastSpokenText()).toContain('Course 0 degrees true');
    });

    it('uses motor-vessel wording for power-vessel radio scripts', async () => {
        mocks.vessel = { name: 'Rescue One', type: 'power' };
        await renderWithFix();

        fireEvent.click(screen.getByRole('button', { name: /Distress/i }));
        fireEvent.click(screen.getByRole('button', { name: 'Speak transcript aloud' }));

        expect(lastSpokenText()).toContain('This is motor vessel Rescue One');
        expect(lastSpokenText()).not.toContain('sailing vessel Rescue One');
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

        fireEvent.click(screen.getByRole('button', { name: 'Speak transcript aloud' }));
        const transcript = lastSpokenText();
        expect(transcript).toContain('Current vessel position 2 7 degrees 30.0 minutes South');
        expect(transcript).toContain('Man Overboard datum 2 7 degrees 15.0 minutes South');
        expect(transcript).toContain('MOB marked at 03:04 UTC');
    });

    it('keeps MOB Mayday speak/copy actions available when current-vessel GPS is unavailable', async () => {
        mocks.vessel = { name: 'Rescue One', type: 'power' };
        mocks.position = null;
        localStorage.setItem(
            authScopedStorageKey('thalassa_dsc_intent'),
            JSON.stringify({ version: 1, kind: 'distress-mob', snapshot: MOB_SNAPSHOT }),
        );

        render(<RadioConsolePage onBack={vi.fn()} />);
        const speakButton = await screen.findByRole('button', { name: 'Speak transcript aloud' });
        await waitFor(() => expect(speakButton).toBeEnabled());
        expect(screen.getByRole('button', { name: 'Copy transcript to clipboard' })).toBeEnabled();

        fireEvent.click(speakButton);
        expect(lastSpokenText()).toContain('Current vessel position is unavailable in this app');
        expect(lastSpokenText()).toContain('Man Overboard datum');
    });

    it('shows a selectable fallback when clipboard access fails', async () => {
        mocks.vessel = { name: 'True North', type: 'sail' };
        mocks.clipboardWrite.mockRejectedValueOnce(new Error('clipboard denied'));
        await renderWithFix();

        fireEvent.click(screen.getByRole('button', { name: 'Copy transcript to clipboard' }));

        expect(await screen.findByText(/Transcript was not copied/i)).toBeInTheDocument();
        const fallback = screen.getByLabelText('Manual radio transcript') as HTMLTextAreaElement;
        expect(fallback.value).toContain('True North');
        expect(fallback.value).not.toContain('COG:');
    });

    it('shows visible read-it-yourself recovery when native synthesis reports onerror', async () => {
        mocks.vessel = { name: 'True North', type: 'sail' };
        mocks.speakSafetyMessage.mockImplementationOnce((_text: string, options: Record<string, unknown>) => {
            (options.onPlaybackStart as (engine: 'native') => void)('native');
            (options.onError as (error: Error) => void)(new Error('synthesis interrupted'));
            return { done: Promise.resolve(), cancel: vi.fn(), engineUsed: () => 'native' };
        });
        await renderWithFix();

        fireEvent.click(screen.getByRole('button', { name: 'Speak transcript aloud' }));

        expect(await screen.findByText(/no complete playback was confirmed/i)).toBeInTheDocument();
        expect(screen.getByText(/This is sailing vessel True North/i)).toBeInTheDocument();
    });
});
