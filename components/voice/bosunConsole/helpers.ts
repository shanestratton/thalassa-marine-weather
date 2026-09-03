/**
 * Pure helpers lifted out of BosunConsole.tsx verbatim — transcript
 * shaping, history serialisation, diagnostics gate, audio decoding and
 * the cloud-reachability probe.
 */
import { useUIStore } from '../../../stores/uiStore';
import type { VoiceHistoryTurn, VoiceTurn } from '../../../types/voice';
import { HISTORY_TURN_LIMIT } from './types';

/**
 * Detect "over" at the end of an utterance. The skipper can say "over"
 * as a hands-free alternative to tap-to-send — same as ham-radio
 * etiquette. We strip it from the transcript before sending so Haiku
 * doesn't see "over" as part of the question.
 *
 * Apple SR is autocorrect-happy and tends to insert punctuation that
 * the previous word-boundary regex couldn't handle ("doing? Over.",
 * "doing, over!", smart quotes, etc.). The two-stage match below is
 * more forgiving: strip trailing punctuation/whitespace first, then
 * look for the literal final word "over".
 *
 * Examples:
 *   "what's the wind doing over"      → matched, cleaned = "what's the wind doing"
 *   "What's the wind doing? Over."    → matched, cleaned = "What's the wind doing?"
 *   "over."                            → matched, cleaned = ""
 *   "moreover"                         → not matched (no whitespace before)
 *   "the storm's moving over to it"   → not matched (not at end)
 */
export function detectOverSuffix(text: string): { matched: boolean; cleaned: string } {
    // Strip trailing punctuation/whitespace so SR-added periods or
    // exclamation marks don't break the suffix match.
    const stripped = text.replace(/[\s.,;:!?'"]+$/, '');
    if (/^over$/i.test(stripped)) {
        return { matched: true, cleaned: '' };
    }
    const m = stripped.match(/^(.+?)\s+over$/i);
    if (m) return { matched: true, cleaned: m[1].trim() };
    return { matched: false, cleaned: text };
}

/**
 * Convert recent VoiceTurns into the {role, text} shape the edge function
 * expects. Drops everything except the user's transcript and the assistant's
 * final answer text — no tool_use/tool_result blocks, since we replay just
 * the conversational thread for continuity.
 */
export function buildHistory(turns: VoiceTurn[]): VoiceHistoryTurn[] {
    const recent = turns.slice(-HISTORY_TURN_LIMIT);
    const out: VoiceHistoryTurn[] = [];
    for (const t of recent) {
        const userText = (t.transcript || '').trim();
        const asstTextRaw = (t.response.answer_text || '').trim();
        if (!userText || !asstTextRaw) continue;
        // Identity-bias fix: persisted history may contain pre-rename
        // assistant turns where she introduced herself as "Bosun". When
        // those get sent back as history, the model picks up the old
        // identity and re-asserts it ("I'm Bosun") even though the
        // current system prompt says Calypso. Replace on the wire so
        // the conversation thread is consistent. Captain's user-text
        // is left alone — they may have legitimately referred to her
        // as Bosun and we don't rewrite their words.
        const asstText = asstTextRaw.replace(/\bBosun\b/g, 'Calypso');
        out.push({ role: 'user', text: userText });
        out.push({ role: 'assistant', text: asstText });
    }
    return out;
}

export function voiceDiagnosticsEnabled(): boolean {
    if (!import.meta.env.DEV) return false;
    try {
        return localStorage.getItem('thalassa_voice_diagnostics') === '1';
    } catch {
        return false;
    }
}

/** Decode a base64 string to a Blob URL for HTML5 audio playback. */
export function audioFromBase64(b64: string, mimeType = 'audio/mpeg'): string {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    return URL.createObjectURL(blob);
}

/**
 * Quick connectivity check for the cloud fallback. Probe-driven
 * (uiStore.isOffline ← internetProbe), NOT navigator.onLine — a boat LAN
 * with a dead WAN uplink reports onLine=true, which would send the voice
 * pipeline down the cloud path just to time out.
 */
export async function checkCloudReachable(): Promise<boolean> {
    return !useUIStore.getState().isOffline;
}
