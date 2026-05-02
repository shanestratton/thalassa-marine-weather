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
