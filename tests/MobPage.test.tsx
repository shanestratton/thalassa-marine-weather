import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    activate: vi.fn(),
    clear: vi.fn(),
    currentState: vi.fn(),
    subscribe: vi.fn(),
    speakSafetyMessage: vi.fn(),
    clipboardWrite: vi.fn(),
    vessel: { name: 'Test Vessel', type: 'sail' } as Record<string, unknown> | undefined,
}));

vi.mock('../services/MobService', () => ({
    MOB_PRECISE_FIX_ACCURACY_M: 100,
    MobService: {
        activate: (...args: unknown[]) => mocks.activate(...args),
        currentState: () => mocks.currentState(),
        subscribe: (...args: unknown[]) => mocks.subscribe(...args),
        clear: (...args: unknown[]) => mocks.clear(...args),
    },
}));

vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        settings: { vessel: mocks.vessel },
    }),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../services/voice/safetyTts', () => ({
    speakSafetyMessage: (...args: unknown[]) => mocks.speakSafetyMessage(...args),
}));

import { MobPage } from '../components/vessel/MobPage';
import { authScopedStorageKey } from '../services/authIdentityScope';

function activeMobState(overrides: Record<string, unknown> = {}) {
    return {
        active: { fixLat: -27.25, fixLon: 153.125, fixAccuracy: 8, activatedAt: Date.UTC(2026, 7, 5, 3, 4) },
        own: null,
        distanceMeters: null,
        bearingDeg: null,
        ownPositionAgeMs: null,
        ownPositionFresh: false,
        elapsedSec: 30,
        persistenceStatus: 'confirmed',
        ...overrides,
    };
}

describe('MobPage activation feedback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.vessel = { name: 'Test Vessel', type: 'sail' };
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
        mocks.currentState.mockReturnValue({
            active: null,
            own: null,
            distanceMeters: null,
            bearingDeg: null,
            ownPositionAgeMs: null,
            ownPositionFresh: false,
            elapsedSec: 0,
            persistenceStatus: 'idle',
        });
        mocks.subscribe.mockReturnValue(vi.fn());
        mocks.activate.mockResolvedValue(null);
    });

    it('fails visibly and non-modally when no fresh GPS fix is available', async () => {
        const browserAlert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        render(<MobPage onBack={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Activate Man Overboard' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('no valid GPS position is available');
        expect(browserAlert).not.toHaveBeenCalled();
        browserAlert.mockRestore();
    });

    it('locks duplicate activation while the emergency GPS request is pending', async () => {
        let resolveActivation!: (value: null) => void;
        mocks.activate.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveActivation = resolve;
            }),
        );
        render(<MobPage onBack={vi.fn()} />);

        const button = screen.getByRole('button', { name: 'Activate Man Overboard' });
        fireEvent.click(button);
        fireEvent.click(button);
        expect(mocks.activate).toHaveBeenCalledTimes(1);
        expect(button).toBeDisabled();

        resolveActivation(null);
        await waitFor(() => expect(button).toBeEnabled());
    });

    it('shows fresh recovery vectors as GPS live', () => {
        mocks.currentState.mockReturnValue({
            active: { fixLat: -27, fixLon: 153.001, fixAccuracy: 4, activatedAt: Date.now() - 30_000 },
            own: {
                latitude: -27,
                longitude: 153,
                accuracy: 5,
                altitude: null,
                heading: null,
                speed: 0,
                timestamp: Date.now() - 1_000,
            },
            distanceMeters: 123,
            bearingDeg: 90,
            ownPositionAgeMs: 1_000,
            ownPositionFresh: true,
            elapsedSec: 30,
            persistenceStatus: 'confirmed',
        });

        render(<MobPage onBack={vi.fn()} />);

        expect(screen.getByText('GPS live')).toBeInTheDocument();
        expect(screen.getByText('090°')).toBeInTheDocument();
        expect(screen.getByText('123 m')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('labels a retained own position as last-known and hides stale vectors', () => {
        mocks.currentState.mockReturnValue({
            active: { fixLat: -27, fixLon: 153.001, fixAccuracy: 4, activatedAt: Date.now() - 30_000 },
            own: {
                latitude: -27,
                longitude: 153,
                accuracy: 5,
                altitude: null,
                heading: null,
                speed: 0,
                timestamp: Date.now() - 16_000,
            },
            // Defensive UI contract: even if an older producer supplies these,
            // the page must not present them when freshness is false.
            distanceMeters: 123,
            bearingDeg: 90,
            ownPositionAgeMs: 16_000,
            ownPositionFresh: false,
            elapsedSec: 30,
            persistenceStatus: 'confirmed',
        });

        render(<MobPage onBack={vi.fn()} />);

        expect(screen.getByText('GPS stale')).toBeInTheDocument();
        expect(screen.queryByText('GPS live')).not.toBeInTheDocument();
        expect(screen.queryByText('090°')).not.toBeInTheDocument();
        expect(screen.queryByText('123 m')).not.toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent(
            'Bearing and distance are hidden until a fresh fix arrives',
        );
        expect(screen.getByText(/Own Position · Last Known/i)).toBeInTheDocument();
        expect(screen.getByText(/Last fix 16s ago/i)).toBeInTheDocument();
    });

    it('warns visibly when restart recovery of an active MOB is not secured', () => {
        mocks.currentState.mockReturnValue({
            active: { fixLat: -27, fixLon: 153.001, fixAccuracy: 4, activatedAt: Date.now() - 30_000 },
            own: null,
            distanceMeters: null,
            bearingDeg: null,
            ownPositionAgeMs: null,
            ownPositionFresh: false,
            elapsedSec: 30,
            persistenceStatus: 'failed',
        });

        render(<MobPage onBack={vi.fn()} />);

        expect(screen.getByText(/MOB is active, but restart recovery is not secured/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /open mob mayday script/i })).toBeInTheDocument();
    });

    it('shows a poor activation fix as a prominent approximate search area', () => {
        mocks.currentState.mockReturnValue({
            active: { fixLat: -27, fixLon: 153.001, fixAccuracy: 250, activatedAt: Date.now() - 10_000 },
            own: null,
            distanceMeters: null,
            bearingDeg: null,
            ownPositionAgeMs: null,
            ownPositionFresh: false,
            elapsedSec: 10,
            persistenceStatus: 'confirmed',
            fixQuality: 'approximate',
        });

        render(<MobPage onBack={vi.fn()} />);

        expect(screen.getByText('Approximate search area')).toBeInTheDocument();
        expect(screen.getByText(/APPROXIMATE MOB MARK.*±250 m uncertainty/i)).toBeInTheDocument();
    });

    it('never substitutes the app name when a crew member has no vessel identity', () => {
        mocks.vessel = undefined;
        mocks.currentState.mockReturnValue(activeMobState());

        render(<MobPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Speak Mayday' }));

        const spoken = String(mocks.speakSafetyMessage.mock.calls[0]?.[0]);
        expect(spoken).toContain('Say your vessel name three times now');
        expect(spoken).toContain('Say your vessel name once now');
        expect(spoken).toContain('Man Overboard datum');
        expect(spoken).not.toContain('Thalassa');
        expect(spoken).not.toContain('Not Set');
        expect(screen.getByText(/will not substitute the app name/i)).toBeInTheDocument();
    });

    it('uses motor-vessel wording for a configured power vessel', () => {
        mocks.vessel = { name: 'Sea Rover', type: 'power' };
        mocks.currentState.mockReturnValue(activeMobState());

        render(<MobPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Speak Mayday' }));

        const spoken = String(mocks.speakSafetyMessage.mock.calls[0]?.[0]);
        expect(spoken).toContain('This is motor vessel Sea Rover');
        expect(spoken).not.toContain('sailing vessel Sea Rover');
    });

    it('shows a selectable Mayday fallback when clipboard copy fails', async () => {
        mocks.currentState.mockReturnValue(activeMobState());
        mocks.clipboardWrite.mockRejectedValueOnce(new Error('clipboard denied'));

        render(<MobPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Copy Mayday' }));

        expect(await screen.findByText(/Mayday was not copied/i)).toBeInTheDocument();
        const fallback = screen.getByLabelText('Manual Mayday transcript') as HTMLTextAreaElement;
        expect(fallback.value).toContain('Man Overboard datum');
        expect(fallback.value).toContain('Test Vessel');
    });

    it('shows visible read-it-yourself recovery when speech synthesis errors after starting', async () => {
        mocks.currentState.mockReturnValue(activeMobState());
        mocks.speakSafetyMessage.mockImplementationOnce((_text: string, options: Record<string, unknown>) => {
            (options.onPlaybackStart as (engine: 'native') => void)('native');
            (options.onError as (error: Error) => void)(new Error('audio route lost'));
            return { done: Promise.resolve(), cancel: vi.fn(), engineUsed: () => 'native' };
        });

        render(<MobPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Speak Mayday' }));

        expect(await screen.findByText(/no complete playback was confirmed/i)).toBeInTheDocument();
        expect((screen.getByLabelText('Manual Mayday transcript') as HTMLTextAreaElement).value).toContain('Mayday');
    });

    it('carries the casualty datum and activation time in the radio handoff', () => {
        const state = activeMobState();
        mocks.currentState.mockReturnValue(state);
        const onNavigate = vi.fn();

        render(<MobPage onBack={vi.fn()} onNavigate={onNavigate} />);
        fireEvent.click(screen.getByRole('button', { name: /open mob mayday script/i }));

        const raw = localStorage.getItem(authScopedStorageKey('thalassa_dsc_intent'));
        expect(JSON.parse(raw ?? '{}')).toEqual({ version: 1, kind: 'distress-mob', snapshot: state.active });
        expect(onNavigate).toHaveBeenCalledWith('radio');
    });
});
