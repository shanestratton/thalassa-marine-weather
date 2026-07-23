import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { useVoiceHistoryStore } from '../stores/voiceHistoryStore';
import type { VoiceTurn } from '../types/voice';

const BASE_STORAGE_KEY = 'thalassa-bosun-voice-history';

function turn(id: string, timestamp: number, audio_b64?: string): VoiceTurn {
    return {
        id,
        timestamp,
        transcript: `question ${id}`,
        response: {
            transcript: `question ${id}`,
            answer_text: `answer ${id}`,
            audio_b64,
            source: 'cloud',
        },
    };
}

function persistedTurnIds(scope = getAuthIdentityScope()): string[] {
    const raw = localStorage.getItem(authScopedStorageKey(BASE_STORAGE_KEY, scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { state?: { turns?: VoiceTurn[] } };
    return (parsed.state?.turns ?? []).map((entry) => entry.id);
}

describe('voice history identity isolation', () => {
    beforeEach(() => {
        localStorage.clear();
        // Force the module-level identity subscriber to replace any state left
        // in memory by the preceding test, even when that test ended anonymous.
        setAuthIdentityScope('__voice-history-test-reset__');
        setAuthIdentityScope(null);
    });

    it('swaps account history synchronously across A → B → A', () => {
        const accountA = setAuthIdentityScope('account-a');
        useVoiceHistoryStore.getState().addTurn(turn('a-1', 10, 'large-audio'));

        expect(useVoiceHistoryStore.getState().turns.map((entry) => entry.id)).toEqual(['a-1']);
        expect(persistedTurnIds(accountA)).toEqual(['a-1']);
        expect(localStorage.getItem(authScopedStorageKey(BASE_STORAGE_KEY, accountA))).not.toContain('large-audio');

        const accountB = setAuthIdentityScope('account-b');
        expect(useVoiceHistoryStore.getState().turns).toEqual([]);
        useVoiceHistoryStore.getState().addTurn(turn('b-1', 20));
        expect(persistedTurnIds(accountB)).toEqual(['b-1']);

        setAuthIdentityScope('account-a');
        expect(useVoiceHistoryStore.getState().turns.map((entry) => entry.id)).toEqual(['a-1']);

        setAuthIdentityScope('account-b');
        expect(useVoiceHistoryStore.getState().turns.map((entry) => entry.id)).toEqual(['b-1']);
    });

    it('keeps anonymous history separate from authenticated accounts', () => {
        const anonymous = getAuthIdentityScope();
        useVoiceHistoryStore.getState().addTurn(turn('anonymous-1', 10));
        expect(persistedTurnIds(anonymous)).toEqual(['anonymous-1']);

        setAuthIdentityScope('account-a');
        expect(useVoiceHistoryStore.getState().turns).toEqual([]);
        useVoiceHistoryStore.getState().addTurn(turn('a-1', 20));

        setAuthIdentityScope(null);
        expect(useVoiceHistoryStore.getState().turns.map((entry) => entry.id)).toEqual(['anonymous-1']);
        expect(persistedTurnIds()).toEqual(['anonymous-1']);
    });

    it('never adopts unattributed history from the legacy global key', () => {
        localStorage.setItem(
            BASE_STORAGE_KEY,
            JSON.stringify({
                state: { turns: [turn('legacy-private-turn', 1)] },
                version: 0,
            }),
        );

        setAuthIdentityScope('account-a');
        expect(useVoiceHistoryStore.getState().turns).toEqual([]);
        expect(persistedTurnIds()).toEqual([]);

        setAuthIdentityScope(null);
        expect(useVoiceHistoryStore.getState().turns).toEqual([]);
        expect(localStorage.getItem(BASE_STORAGE_KEY)).toContain('legacy-private-turn');
    });

    it('rejects delayed actions captured before an identity transition', () => {
        const accountA = setAuthIdentityScope('account-a');
        useVoiceHistoryStore.getState().addTurn(turn('a-existing', 10));
        const staleAdd = useVoiceHistoryStore.getState().addTurn;
        const staleUpsert = useVoiceHistoryStore.getState().upsertTurnSorted;
        const staleClear = useVoiceHistoryStore.getState().clearHistory;

        const accountB = setAuthIdentityScope('account-b');
        useVoiceHistoryStore.getState().addTurn(turn('b-current', 20));

        staleAdd(turn('late-a-add', 30));
        staleUpsert(turn('late-a-upsert', 5));
        staleClear();

        expect(useVoiceHistoryStore.getState().turns.map((entry) => entry.id)).toEqual(['b-current']);
        expect(persistedTurnIds(accountB)).toEqual(['b-current']);
        expect(persistedTurnIds(accountA)).toEqual(['a-existing']);

        // Returning to the same account key still has a newer generation.
        // The original closure must remain stale rather than becoming valid
        // again and behaving like a timer that survived sign-out/sign-in.
        setAuthIdentityScope('account-a');
        staleAdd(turn('late-after-return', 40));
        staleClear();
        expect(useVoiceHistoryStore.getState().turns.map((entry) => entry.id)).toEqual(['a-existing']);

        useVoiceHistoryStore.getState().addTurn(turn('a-current', 50));
        expect(useVoiceHistoryStore.getState().turns.map((entry) => entry.id)).toEqual(['a-existing', 'a-current']);
    });

    it('preserves ordering, de-duplication, and the 25-turn cap per account', () => {
        setAuthIdentityScope('account-a');
        useVoiceHistoryStore.getState().upsertTurnSorted(turn('middle', 20));
        useVoiceHistoryStore.getState().upsertTurnSorted(turn('first', 10));
        useVoiceHistoryStore.getState().upsertTurnSorted(turn('last', 30));
        useVoiceHistoryStore.getState().upsertTurnSorted(turn('middle', 999));

        expect(useVoiceHistoryStore.getState().turns.map((entry) => entry.id)).toEqual(['first', 'middle', 'last']);

        useVoiceHistoryStore.getState().clearHistory();
        for (let index = 0; index < 30; index++) {
            useVoiceHistoryStore.getState().addTurn(turn(`turn-${index}`, index));
        }

        expect(useVoiceHistoryStore.getState().turns).toHaveLength(25);
        expect(useVoiceHistoryStore.getState().turns[0]?.id).toBe('turn-5');
        expect(useVoiceHistoryStore.getState().turns.at(-1)?.id).toBe('turn-29');
        expect(persistedTurnIds()).toHaveLength(25);
    });

    it('keeps in-memory history current when localStorage remains over quota', () => {
        const accountA = setAuthIdentityScope('account-a');
        const scopedKey = authScopedStorageKey(BASE_STORAGE_KEY, accountA);
        const originalSetItem = Storage.prototype.setItem;
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
            if (key === scopedKey) {
                throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            }
            return originalSetItem.call(this, key, value);
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            expect(() => useVoiceHistoryStore.getState().addTurn(turn('memory-only', 10))).not.toThrow();
            expect(useVoiceHistoryStore.getState().turns.map((entry) => entry.id)).toEqual(['memory-only']);
            expect(persistedTurnIds(accountA)).toEqual([]);
        } finally {
            setItem.mockRestore();
            warn.mockRestore();
        }
    });
});
