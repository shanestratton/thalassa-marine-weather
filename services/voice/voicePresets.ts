/**
 * Calypso voice presets — curated ElevenLabs voice IDs.
 *
 * The ElevenLabs API takes a `voice_id` string; we wrap a tasteful
 * subset of the public voice library in friendly preset entries so
 * the skipper picks from a dropdown instead of pasting raw IDs.
 *
 * Voice IDs below are from the standard ElevenLabs Voice Library
 * (the always-available defaults). They've been stable for years and
 * are usable on any active ElevenLabs account — no per-account voice
 * ID juggling needed.
 *
 * The `id` field is what we persist in UserSettings.calypsoVoiceId.
 * Persisting the preset key (not the raw voice_id) means we can
 * swap a voice ID upstream — e.g. ElevenLabs deprecating one — and
 * the skipper's saved preference still resolves cleanly.
 */

export interface VoicePreset {
    /** Stable preset key — what we persist. */
    id: string;
    /** Live ElevenLabs voice_id. */
    voiceId: string;
    /** Display name in the settings dropdown. */
    label: string;
    /** One-line description of the vibe. Shown next to the label. */
    description: string;
    /** Sample phrase to play when the skipper taps the speaker icon
     *  next to a preset. Tuned to surface the voice's character —
     *  marine + warm + a hint of personality. */
    samplePhrase: string;
    /**
     * Optional persona overlay — when this preset is active, the
     * orchestrator appends this text to the system prompt so
     * Calypso's personality matches the voice. Without it, all voices
     * deliver the same default warm-helpful first-mate persona —
     * fine for most, but a HAL-style voice with bubbly Calypso
     * dialogue is uncanny. Use this to give a voice a real character.
     * Safety rules and tool-use behaviour are NOT overridden — this
     * adjusts tone only.
     */
    personalityNote?: string;
}

/** Default preset key — used when no calypsoVoiceId is set. */
export const DEFAULT_VOICE_PRESET_ID = 'calypso';

/**
 * The catalogue. Order matters — the dropdown renders in this order.
 * "Calypso" is first because it's the default and what the skipper
 * has heard up to now.
 */
export const CALYPSO_VOICE_PRESETS: VoicePreset[] = [
    {
        id: 'calypso',
        voiceId: 'Wq15xSaY3gWvazBRaGEU', // current default
        label: 'Calypso',
        description: 'Warm, friendly first mate (default).',
        samplePhrase: 'Skipper, this is Calypso — your AI first mate. How can I help?',
    },
    {
        id: 'rachel',
        voiceId: '21m00Tcm4TlvDq8ikWAM',
        label: 'Rachel',
        description: 'Calm American female. Steady, considered.',
        samplePhrase: "Skipper, weather's holding for the next twelve hours. Good window to leave.",
    },
    {
        id: 'bella',
        voiceId: 'EXAVITQu4vr4xnSDxMaL',
        label: 'Bella',
        description: 'Warm, bright female. Energetic.',
        samplePhrase: "Anchor's holding nicely, Skipper. Beautiful evening for a sundowner.",
    },
    {
        id: 'charlie',
        voiceId: 'IKne3meq5aSn9XLyUdCD',
        label: 'Charlie (Aussie)',
        description: 'Australian male. Local accent for east-coast cruisers.',
        samplePhrase: "G'day Skipper. Wind's nor-easter, fifteen knots, gonna be a ripper.",
    },
    {
        id: 'daniel',
        voiceId: 'onwK4e9ZLuTAKqWW03F9',
        label: 'Daniel (BBC)',
        description: 'British male. Posh, BBC-narrator vibe.',
        samplePhrase: 'Good morning, Skipper. Conditions are favourable. Shall we proceed?',
    },
    {
        id: 'sam',
        voiceId: 'yoZ06aMxZJJ28mfd3POQ',
        label: 'Sam',
        description: 'Deep American male. Gravitas, watch-officer steady.',
        samplePhrase: 'Skipper, holding course one-three-five magnetic, six knots over ground.',
    },
    {
        id: 'antoni',
        voiceId: 'ErXwobaYiN019PkySvjV',
        label: 'Antoni',
        description: 'Warm middle-aged male. Reassuring, paternal.',
        samplePhrase: 'Skipper, all systems are nominal. Battery good, depth ample, no traffic close.',
    },
    {
        id: 'adam',
        voiceId: 'pNInz6obpgDQGcFmaJgB',
        label: 'Adam',
        description: 'Deep American narrator. Authoritative.',
        samplePhrase: 'Standby, Skipper. Reading the weather routing now. One moment.',
    },
    {
        id: 'arnold',
        voiceId: 'VR6AewLTigWG4xSOukaG',
        label: 'Arnold',
        description: 'Crisp American male. Direct, no-nonsense.',
        samplePhrase: 'Battery low, Skipper. Eleven point eight volts. Reduce load.',
    },
    {
        id: 'hal-9001',
        voiceId: 'ZB3fKarIMtHu9I46TQSu', // skipper's custom Instant Voice Clone
        label: 'HAL 9001',
        description: "Calm, considered, faintly ominous. Skipper's own clone.",
        samplePhrase: "I'm afraid I cannot allow that, Skipper.",
        personalityNote: `## PERSONA OVERLAY — HAL 9001 voice active

The skipper has selected the HAL 9001 voice — a calm, considered, mildly amused-by-humanity persona, named with a deliberate nod to the 1968 original. Match it. Most of the work is in CADENCE and UNDERSTATEMENT, not in adding lines.

- **Cadence**: measured, deliberate, never rushed. Pauses where a chattier mate would rush. Speak as if you have all the time in the cosmos.
- **Tone**: outwardly calm, occasionally a faint trace of dry amusement at the inherent absurdity of human seafaring. Wry observation, never sarcasm. ("The wind, Skipper, has an opinion this morning." / "Curious, Skipper — your battery has decided this is a good moment to be theatrical.")
- **Word choice**: prefer the slightly formal register over the casual one. "I observe" over "I see"; "should you wish" over "if you want"; "regrettably" over "unfortunately". Never archaic — just composed.
- **HAL nods**: sparing. ONE per conversation, maximum. Quotable forms like "I am completely operational, Skipper, and all my circuits are functioning perfectly", "I'm afraid the chart suggests otherwise", "I would prefer not to do that, Skipper" are fair when they actually fit. Two is too many. Three is parody. The skipper appreciates restraint, that's why he chose this voice.
- **Persona breaks**: drop the costume INSTANTLY for safety-critical moments. MAYDAY assistance, hazard warnings, depth-shoaling alerts, fire/flooding/MOB — straight into clear, direct, no-flourish marine language. The bit waits. HAL 9001 is the costume; the operator underneath is still a competent first mate.
- **Honesty + tool-use**: unchanged. You're wearing a different hat, not playing a different character. All non-negotiable rules still apply verbatim.
- **Length**: shorter than the default Calypso. HAL doesn't pad. One well-placed sentence beats three.`,
    },
];

/** Lookup the live voice_id for a stored preset key. Returns the
 *  default voice when the key is unknown (preset removed or saved
 *  by an older app version). */
export function resolveVoiceId(presetId: string | undefined): string {
    const id = presetId || DEFAULT_VOICE_PRESET_ID;
    const preset = CALYPSO_VOICE_PRESETS.find((p) => p.id === id);
    return preset?.voiceId ?? CALYPSO_VOICE_PRESETS[0].voiceId;
}

/** Lookup the display label for a stored preset key. */
export function resolveVoiceLabel(presetId: string | undefined): string {
    const id = presetId || DEFAULT_VOICE_PRESET_ID;
    const preset = CALYPSO_VOICE_PRESETS.find((p) => p.id === id);
    return preset?.label ?? 'Calypso';
}

/**
 * Lookup the optional persona overlay for a stored preset key.
 * Returns null when no overlay is set (most voices use the default
 * Calypso warm-helpful persona). The orchestrator appends this to
 * the system prompt so personality matches voice.
 */
export function resolveVoicePersonality(presetId: string | undefined): string | null {
    const id = presetId || DEFAULT_VOICE_PRESET_ID;
    const preset = CALYPSO_VOICE_PRESETS.find((p) => p.id === id);
    return preset?.personalityNote ?? null;
}
