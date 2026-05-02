/**
 * voiceHistoryStore — Zustand-persisted conversation history for Bosun.
 *
 * Replaces the per-component-mount `useState<VoiceTurn[]>` in BosunConsole
 * so the skipper's conversation survives closing + reopening the voice
 * console. The most-recent slice (HISTORY_TURN_LIMIT) is sent with each
 * Haiku request as `history` for continuity ("for the next 3 questions,
 * speak like a pirate" persists across console opens now).
 *
 * Storage: localStorage via Zustand's persist middleware. WKWebView gives
 * us localStorage with no extra plumbing; we don't need the native
 * Capacitor Preferences plugin for this — the data is small and not
 * security-sensitive.
 *
 * Cap: MAX_PERSISTED_TURNS keeps the store from growing forever. The
 * sending cap (HISTORY_TURN_LIMIT in BosunConsole) is separate and
 * stricter — older turns stay in the UI for the skipper to scroll back
 * through, but Haiku only sees the most recent slice.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { VoiceTurn } from '../types/voice';

/**
 * Hard cap on how many turns we keep in localStorage. Each turn is
 * roughly 300-1500 bytes (transcript + answer + base64 audio if any).
 * 50 turns ≈ at most a few hundred KB, well within localStorage limits.
 */
const MAX_PERSISTED_TURNS = 50;

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
            storage: createJSONStorage(() => localStorage),
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
