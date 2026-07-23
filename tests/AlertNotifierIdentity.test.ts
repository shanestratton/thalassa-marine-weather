import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertEvent } from '../types/alerts';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const alertMocks = vi.hoisted(() => ({
    startAlarm: vi.fn(() => Promise.resolve()),
    stopAlarm: vi.fn(() => Promise.resolve()),
    synthesise: vi.fn(),
    addTurn: vi.fn(),
}));

vi.mock('../services/AlarmAudioService', () => ({
    AlarmAudioService: {
        startAlarm: alertMocks.startAlarm,
        stopAlarm: alertMocks.stopAlarm,
    },
}));

vi.mock('../services/voice/ttsClient', () => ({
    synthesise: alertMocks.synthesise,
}));

vi.mock('../stores/voiceHistoryStore', () => ({
    useVoiceHistoryStore: {
        getState: () => ({ addTurn: alertMocks.addTurn }),
    },
}));

import { dispatchAlert } from '../services/AlertNotifier';

function event(ruleId: string, firedAt: number, severity: AlertEvent['severity'] = 'warn'): AlertEvent {
    return {
        ruleId,
        severity,
        spokenMessage: `Alert ${ruleId}`,
        title: ruleId,
        firstViolatingAt: firedAt - 1_000,
        firedAt,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope(null);
    setAuthIdentityScope('account-a');
    alertMocks.synthesise.mockResolvedValue(null);
});

afterEach(() => {
    setAuthIdentityScope(null);
});

describe('AlertNotifier identity and concurrency fences', () => {
    it('drops synthesis that finishes after the account changes', async () => {
        let resolveSynthesis!: (audio: string | null) => void;
        alertMocks.synthesise.mockReturnValueOnce(
            new Promise<string | null>((resolve) => {
                resolveSynthesis = resolve;
            }),
        );

        const dispatching = dispatchAlert(event('account-a-alert', 1_000));
        setAuthIdentityScope('account-b');
        resolveSynthesis(null);
        await dispatching;

        expect(alertMocks.addTurn).not.toHaveBeenCalled();
    });

    it('lets the newest alert supersede an older in-flight synthesis', async () => {
        let resolveFirst!: (audio: string | null) => void;
        let resolveSecond!: (audio: string | null) => void;
        alertMocks.synthesise
            .mockReturnValueOnce(
                new Promise<string | null>((resolve) => {
                    resolveFirst = resolve;
                }),
            )
            .mockReturnValueOnce(
                new Promise<string | null>((resolve) => {
                    resolveSecond = resolve;
                }),
            );

        const first = dispatchAlert(event('older', 1_000));
        const second = dispatchAlert(event('newer', 2_000));
        resolveFirst(null);
        await first;
        expect(alertMocks.addTurn).not.toHaveBeenCalled();

        resolveSecond(null);
        await second;
        expect(alertMocks.addTurn).toHaveBeenCalledOnce();
        expect(alertMocks.addTurn).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-newer-2000' }));
    });

    it('abandons a critical alert if identity changes while the chime starts', async () => {
        let resolveChime!: () => void;
        alertMocks.startAlarm.mockReturnValueOnce(
            new Promise<void>((resolve) => {
                resolveChime = resolve;
            }),
        );

        const dispatching = dispatchAlert(event('critical', 3_000, 'critical'));
        setAuthIdentityScope('account-b');
        resolveChime();
        await dispatching;

        expect(alertMocks.stopAlarm).toHaveBeenCalled();
        expect(alertMocks.synthesise).not.toHaveBeenCalled();
        expect(alertMocks.addTurn).not.toHaveBeenCalled();
    });
});
