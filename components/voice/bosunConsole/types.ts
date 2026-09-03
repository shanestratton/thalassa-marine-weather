/**
 * Shared types and tuning constants for the Calypso voice console.
 * Split out of BosunConsole.tsx verbatim — no values changed.
 */
import type { TalkButtonState } from '../TalkButton';
import type { AuthIdentityScope } from '../../../services/authIdentityScope';

/**
 * How many prior turns to send for context. Each turn = one user + one
 * assistant message, so 2 turns = 4 messages. Tuned aggressively down
 * (was 4, was 10 originally) because each call carries 1.5-3K tokens
 * of state context + tool definitions + this history slice, which
 * stacks against per-minute Anthropic rate limits when the skipper
 * fires several queries in succession. Recent style-instructions still
 * persist (e.g. "speak like a pirate") within ~2 turns; older context
 * gets trimmed.
 */
export const HISTORY_TURN_LIMIT = 2;

/**
 * Feature flag — disable Apple SR's slot in the fallback chain.
 *
 * Why this exists: when both Deepgram and Apple SR are wired in,
 * silent failures on the Deepgram path cascade into Apple SR, which
 * then hits its per-device quota lockout, which then cascades into
 * MediaRecorder. The skipper sees the "iOS speech-recognition rate
 * limit" toast and we have no way to tell whether Deepgram even ran.
 *
 * Set to false to make Deepgram → MediaRecorder the only path. Apple
 * SR is skipped entirely — its status pill stays informational but
 * its handler never runs. If Deepgram fails for any reason, the
 * cascade goes straight to MediaRecorder + Scribe (loses the live
 * OVER gesture but keeps the question quality via strip-at-stop).
 *
 * Flip to true once we're confident Deepgram is reliable on the
 * skipper's iOS device.
 */
export const ENABLE_APPLE_SR_FALLBACK = false;

export interface BosunConsoleProps {
    /**
     * Optional back-navigation callback. When provided, the page header
     * renders a back button that calls this. Routed pages typically pass
     * `() => setPage('dashboard')` (or wherever the skipper came from).
     */
    onBack?: () => void;
}

export interface TargetState {
    bosun: TalkButtonState;
    cloud: TalkButtonState;
}

export const initialTargetState: TargetState = { bosun: 'idle', cloud: 'idle' };

export interface VoiceOperation {
    readonly identity: AuthIdentityScope;
    readonly lifecycleGeneration: number;
}

export const PREWARM_FAIL_OPEN_MS = 6_000;
