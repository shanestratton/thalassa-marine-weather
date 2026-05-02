/**
 * voiceHistoryStore — Zustand-persisted conversation history for Bosun.
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

import { create } from 'zustand';
import type { StateStorage } from 'zustand/middleware';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { VoiceTurn } from '../types/voice';

/**
 * Hard cap on how many turns we keep in localStorage. Reduced from 50
 * to 25 because each turn averages ~1-2KB even after audio_b64 strip
 * (transcript + answer text + tool_calls metadata + crew attribution),
 * and we share ~5MB of localStorage with many other stores in the app.
 * 25 turns ≈ 50KB which is plenty of conversation context for the
 * skipper to scroll through.
 */
const MAX_PERSISTED_TURNS = 25;

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

export const useVoiceHistoryStore = create<VoiceHistoryState>()(
    persist(
        (set) => ({
            turns: [],
            addTurn: (turn) =>
                set((state) => {
                    // Dedupe local-write echoes too: if a turn with this
                    // id already exists, leave the existing one alone.
                    if (state.turns.some((t) => t.id === turn.id)) return state;
                    const next = [...state.turns, turn];
                    return { turns: next.slice(-MAX_PERSISTED_TURNS) };
                }),
            upsertTurnSorted: (turn) =>
                set((state) => {
                    if (state.turns.some((t) => t.id === turn.id)) return state;
                    // Find insert position by timestamp. Most remote turns
                    // arrive at the end, but a crewmate's older turn could
                    // race — putting them in chronological order keeps the
                    // conversation log readable.
                    const next = [...state.turns];
                    let i = next.length - 1;
                    while (i >= 0 && next[i].timestamp > turn.timestamp) i--;
                    next.splice(i + 1, 0, turn);
                    return { turns: next.slice(-MAX_PERSISTED_TURNS) };
                }),
            clearHistory: () => set({ turns: [] }),
        }),
        {
            name: 'thalassa-bosun-voice-history',
            storage: createJSONStorage(() => quotaAwareStorage),
            // Don't persist the audio_b64 on each turn — it's the biggest
            // field and we have no need to replay TTS across sessions.
            // Skipper sees the text; replay button is fine to be disabled
            // on rehydrated turns.
            partialize: (state) => ({
                turns: state.turns.map((t) => ({
                    ...t,
                    response: { ...t.response, audio_b64: undefined },
                })),
            }),
        },
    ),
);
