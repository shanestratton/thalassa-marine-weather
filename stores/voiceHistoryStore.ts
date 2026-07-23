/**
 * voiceHistoryStore — identity-scoped conversation history for Bosun.
 *
 * Replaces the per-component-mount `useState<VoiceTurn[]>` in BosunConsole
 * so the skipper's conversation survives closing + reopening the voice
 * console. The most-recent slice (HISTORY_TURN_LIMIT) is sent with each
 * Haiku request as `history` for continuity ("for the next 3 questions,
 * speak like a pirate" persists across console opens now).
 *
 * Storage: localStorage via Zustand's persist middleware, wrapped with a
 * quota-aware adapter that auto-prunes the persisted slice on
 * QuotaExceededError instead of letting iOS Safari's native "The quota
 * has been exceeded." propagate up through the catch chain into the
 * voice console's error toast.
 *
 * Why this matters: iOS WKWebView caps localStorage at ~5MB per origin.
 * Across all our Zustand-persisted stores plus Capacitor Preferences
 * plus the chart cache, we can reach that cap during long testing
 * sessions. Without this wrapper, the next setItem throws synchronously
 * from inside zustand's persist middleware, propagating up through
 * appendTurn → handleResponse → into sendVoiceQuery's catch — Calypso
 * appears to "fail" even though her reply is already on screen.
 */

import { create, type StoreApi } from 'zustand';
import type { StateStorage } from 'zustand/middleware';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { VoiceTurn } from '../types/voice';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

/**
 * Hard cap on how many turns we keep in localStorage. Reduced from 50
 * to 25 because each turn averages ~1-2KB even after audio_b64 strip
 * (transcript + answer text + tool_calls metadata + crew attribution),
 * and we share ~5MB of localStorage with many other stores in the app.
 * 25 turns ≈ 50KB which is plenty of conversation context for the
 * skipper to scroll through.
 */
const MAX_PERSISTED_TURNS = 25;
const STORAGE_KEY = 'thalassa-bosun-voice-history';

interface VoiceHistoryState {
    turns: VoiceTurn[];
    addTurn: (turn: VoiceTurn) => void;
    /**
     * Insert a remote turn (from a crewmate via conversationSync) sorted
     * by timestamp. De-dupes by id — if the same turn already exists
     * (because we authored it locally and then Realtime echoed it back)
     * the call is a no-op. Used by the voice console's Realtime
     * subscription handler.
     */
    upsertTurnSorted: (turn: VoiceTurn) => void;
    clearHistory: () => void;
}

/**
 * Quota-aware localStorage wrapper. Identical to plain localStorage
 * except that setItem catches QuotaExceededError and prunes our own
 * persisted history before retrying.
 *
 * The pruning strategy:
 *   1. Catch QuotaExceededError (name match — works on Safari, Chrome,
 *      Firefox; iOS WKWebView throws DOMException with
 *      name="QuotaExceededError" and code=22).
 *   2. Parse our existing persisted state, slice the turns array to
 *      half its current size, write that smaller version back.
 *   3. Retry the original setItem with the new value the caller passed.
 *      The new value still has 25 turns; persistence after this write
 *      replaces the smaller backed-up state with the full 25.
 *
 * If the retry also fails (i.e. we're still over quota even after our
 * own state shrunk — meaning OTHER stores are dominating space), we
 * swallow the error so it doesn't propagate up through the zustand
 * persist callback into the React render path. The in-memory state
 * stays current; the persist failure just means session history won't
 * survive a reload, which is a soft degradation rather than a crash.
 */
const quotaAwareStorage: StateStorage = {
    getItem: (name) => {
        try {
            return localStorage.getItem(name);
        } catch {
            return null;
        }
    },
    setItem: (name, value) => {
        try {
            localStorage.setItem(name, value);
        } catch (err) {
            const e = err as { name?: string; code?: number; message?: string };
            const isQuota =
                e?.name === 'QuotaExceededError' || e?.code === 22 || /quota.{0,15}exceeded/i.test(e?.message ?? '');
            if (!isQuota) throw err;

            // Storage full. Prune our own persisted slice, then retry
            // with the value the caller passed. Best-effort — if the
            // existing payload doesn't parse or is empty, fall through
            // to the bare retry.
            console.warn('[voiceHistoryStore] localStorage QuotaExceededError — pruning + retrying');
            try {
                const existingRaw = localStorage.getItem(name);
                if (existingRaw) {
                    const parsed = JSON.parse(existingRaw) as { state?: { turns?: VoiceTurn[] } };
                    const existingTurns = parsed.state?.turns ?? [];
                    if (existingTurns.length > 0) {
                        const half = Math.max(1, Math.floor(existingTurns.length / 2));
                        const trimmed = {
                            ...parsed,
                            state: { ...parsed.state, turns: existingTurns.slice(-half) },
                        };
                        localStorage.setItem(name, JSON.stringify(trimmed));
                    }
                }
            } catch {
                // Pre-prune parse failed — try the bare retry below anyway.
            }

            try {
                localStorage.setItem(name, value);
            } catch {
                // Still over quota. Other stores must be dominating.
                // Swallow — in-memory state is fine, just won't persist
                // this turn. Better than throwing and breaking the
                // voice console.
                console.warn('[voiceHistoryStore] still over quota after prune; persist skipped this cycle');
            }
        }
    },
    removeItem: (name) => {
        try {
            localStorage.removeItem(name);
        } catch {
            /* ignore */
        }
    },
};

function scopedStorageKey(scope: AuthIdentityScope = getAuthIdentityScope()): string {
    return authScopedStorageKey(STORAGE_KEY, scope);
}

function isVoiceTurn(value: unknown): value is VoiceTurn {
    if (!value || typeof value !== 'object') return false;
    const turn = value as Partial<VoiceTurn>;
    if (
        typeof turn.id !== 'string' ||
        !Number.isFinite(turn.timestamp) ||
        typeof turn.transcript !== 'string' ||
        !turn.response ||
        typeof turn.response !== 'object'
    ) {
        return false;
    }

    const response = turn.response;
    return (
        typeof response.transcript === 'string' &&
        typeof response.answer_text === 'string' &&
        (response.source === 'bosun' || response.source === 'cloud' || response.source === 'unknown')
    );
}

/**
 * Read only the current identity's namespace. The old unscoped key is
 * intentionally never adopted: it contains no trustworthy owner marker, so
 * assigning it to whichever account happens to sign in first would expose one
 * skipper's private conversation to another.
 */
function readPersistedTurns(scope: AuthIdentityScope): VoiceTurn[] {
    // This adapter is deliberately synchronous even though StateStorage also
    // permits async implementations.
    const raw = quotaAwareStorage.getItem(scopedStorageKey(scope)) as string | null;
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw) as { state?: { turns?: unknown } };
        const turns = parsed.state?.turns;
        if (!Array.isArray(turns)) return [];
        return turns.filter(isVoiceTurn).slice(-MAX_PERSISTED_TURNS);
    } catch {
        return [];
    }
}

const identityScopedQuotaStorage: StateStorage = {
    getItem: () => quotaAwareStorage.getItem(scopedStorageKey()),
    setItem: (_name, value) => quotaAwareStorage.setItem(scopedStorageKey(), value),
    removeItem: () => quotaAwareStorage.removeItem(scopedStorageKey()),
};

type BoundActions = Pick<VoiceHistoryState, 'addTurn' | 'upsertTurnSorted' | 'clearHistory'>;

let setStoreState: StoreApi<VoiceHistoryState>['setState'];

function actionsForScope(scope: AuthIdentityScope): BoundActions {
    return {
        addTurn: (turn) => {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setStoreState((state: VoiceHistoryState) => {
                if (!isAuthIdentityScopeCurrent(scope) || state.turns.some((existing) => existing.id === turn.id)) {
                    return state;
                }
                const turns = [...state.turns, turn].slice(-MAX_PERSISTED_TURNS);
                return { turns };
            });
        },
        upsertTurnSorted: (turn) => {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setStoreState((state: VoiceHistoryState) => {
                if (!isAuthIdentityScopeCurrent(scope) || state.turns.some((existing) => existing.id === turn.id)) {
                    return state;
                }

                // Most remote turns arrive at the end, but an older crewmate
                // turn can race. Keep the shared conversation chronological.
                const turns = [...state.turns];
                let index = turns.length - 1;
                while (index >= 0 && turns[index].timestamp > turn.timestamp) index--;
                turns.splice(index + 1, 0, turn);
                const cappedTurns = turns.slice(-MAX_PERSISTED_TURNS);
                return { turns: cappedTurns };
            });
        },
        clearHistory: () => {
            if (!isAuthIdentityScopeCurrent(scope)) return;
            setStoreState((state: VoiceHistoryState) => {
                if (!isAuthIdentityScopeCurrent(scope)) return state;
                return { turns: [] };
            });
        },
    };
}

const initialScope = getAuthIdentityScope();

export const useVoiceHistoryStore = create<VoiceHistoryState>()(
    persist(
        (set) => {
            setStoreState = set;
            return {
                turns: [],
                ...actionsForScope(initialScope),
            };
        },
        {
            name: STORAGE_KEY,
            storage: createJSONStorage(() => identityScopedQuotaStorage),
            merge: (persisted, current) => {
                const turns = (persisted as Partial<VoiceHistoryState> | undefined)?.turns;
                return {
                    ...current,
                    turns: Array.isArray(turns) ? turns.filter(isVoiceTurn).slice(-MAX_PERSISTED_TURNS) : [],
                };
            },
            // Don't persist audio_b64 — it is the largest field and replaying
            // TTS across application sessions is unnecessary.
            partialize: (state) => ({
                turns: state.turns.map((turn) => ({
                    ...turn,
                    response: { ...turn.response, audio_b64: undefined },
                })),
            }),
        },
    ),
);

subscribeAuthIdentityScope((next) => {
    // Swap both data and action closures synchronously. A timer or async
    // callback holding account A's old action cannot mutate account B after
    // this listener returns because that action remains fenced to A.
    try {
        useVoiceHistoryStore.setState(
            {
                turns: readPersistedTurns(next),
                ...actionsForScope(next),
            },
            true,
        );
    } catch (error) {
        // Zustand applies the in-memory replacement before persistence. Do not
        // let disabled/corrupt browser storage abort the auth fence and prevent
        // later identity subscribers from clearing their own private state.
        console.warn('[voiceHistoryStore] failed to persist identity transition', error);
    }
});
