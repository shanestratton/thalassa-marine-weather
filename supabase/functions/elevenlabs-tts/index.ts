// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import {
    fetchWithTimeout,
    jsonResponse,
    readJsonObject,
    readResponseArrayBufferLimited,
    readResponseTextLimited,
} from '../_shared/http-security.ts';

/**
 * elevenlabs-tts — thin TTS forwarder for the iOS orchestrator.
 *
 * Extracted from proxy-bosun-fallback so the new client-side
 * orchestrator (services/voice/orchestrator.ts) can request audio for
 * the final answer text without going through the full Anthropic +
 * tool-loop pipeline. Holds ELEVENLABS_API_KEY server-side.
 *
 * Request body:
 *   { "text": "string to speak", "voice_id"?: "override" }
 *
 * Response: base64-encoded MP3 wrapped in JSON for transport simplicity:
 *   { "audio_b64": "base64...", "ms": 1820 }
 *
 * Why base64 + JSON instead of raw audio bytes: iOS WKWebView fetch is
 * happier with text payloads than ArrayBuffer over CORS, and the
 * existing voice console code path already decodes base64. Avoids a
 * client-side rewrite for marginal wire savings.
 *
 * Tweaks copied from the legacy function:
 *   - prepareForTTS() hyphenates "Serene Summer" so Flash treats it as
 *     one phonetic unit instead of stalling on the proper-noun pair.
 *   - voice_settings.speed: 1.1 for a touch quicker delivery.
 *   - model_id: eleven_flash_v2_5 — lowest-latency tier.
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const DEFAULT_VOICE_ID = 'Wq15xSaY3gWvazBRaGEU';

/**
 * Convert an integer in the typical atmospheric-pressure range
 * (~900-1100) to its English word form so ElevenLabs reads it as
 * "one thousand and twenty hectopascals" instead of the year-style
 * "ten twenty hectopascals" that 4-digit-number heuristics produce.
 *
 * Australian/British convention with "and" before the tens position
 * because that's the skipper's accent. Outside the supported range
 * (which covers any real-world atmospheric pressure on Earth) this
 * returns the original string unchanged so Flash falls back to its
 * default reading.
 */
const ONES_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS_WORDS = [
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
];
const TENS_WORDS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function pressureToWords(n: number): string {
    if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n);
    if (n === 0) return 'zero';
    const parts: string[] = [];
    const thousands = Math.floor(n / 1000);
    const hundreds = Math.floor((n % 1000) / 100);
    const remainder = n % 100;
    if (thousands > 0) parts.push(`${ONES_WORDS[thousands]} thousand`);
    if (hundreds > 0) parts.push(`${ONES_WORDS[hundreds]} hundred`);
    if (remainder > 0) {
        if (parts.length > 0) parts.push('and');
        if (remainder < 10) parts.push(ONES_WORDS[remainder]);
        else if (remainder < 20) parts.push(TEENS_WORDS[remainder - 10]);
        else {
            const tens = Math.floor(remainder / 10);
            const ones = remainder % 10;
            parts.push(ones === 0 ? TENS_WORDS[tens] : `${TENS_WORDS[tens]}-${ONES_WORDS[ones]}`);
        }
    }
    return parts.join(' ');
}

/**
 * Reshape Calypso's answer text right before TTS so Flash v2.5
 * pronounces marine units correctly. The model SHOULD emit units as
 * full words (system prompt instructs it to), but TTS abbreviation
 * expansion is unreliable enough that we belt-and-braces here too.
 *
 * Observed mispronunciations on Flash before this transform:
 *   - "2.5 m"      → "two point five MINUTES"   (wanted: metres)
 *   - "1020 hPa"   → "ten twenty H P A"         (wanted: hectopascals)
 *   - "1020 hectopascals" → "ten twenty hectopascals"
 *                                                (wanted: "one thousand
 *                                                 and twenty")
 *   - "22°C"       → "twenty-two DECESS"        (wanted: degrees Celsius)
 *   - "15 kt"      → "fifteen K T"              (wanted: knots)
 *
 * All regexes anchor on a leading number so we don't accidentally
 * rewrite words like "I'm" or "moonlit" that contain unit-shaped
 * letter pairs in non-unit contexts.
 */
function prepareForTTS(text: string): string {
    return (
        text
            // Vessel name — hyphenate so Flash treats as one phonetic unit
            .replace(/\bSerene Summer\b/g, 'Serene-Summer')
            // Temperature: "22°C" / "22 °C" / "22 °F"
            .replace(/(\d+(?:\.\d+)?)\s*°\s*C\b/g, '$1 degrees Celsius')
            .replace(/(\d+(?:\.\d+)?)\s*°\s*F\b/g, '$1 degrees Fahrenheit')
            // Pressure: "1020 hPa" / "1020hPa" — ElevenLabs reads "hPa"
            // letter-by-letter as "H P A" or as "huppa" without this.
            .replace(/(\d+(?:\.\d+)?)\s*hPa\b/gi, '$1 hectopascals')
            // Spell out the pressure number itself in the typical
            // atmospheric range so Flash reads "one thousand and
            // twenty hectopascals" instead of "ten twenty
            // hectopascals" (year-style 4-digit heuristic).
            .replace(/(\d{3,4})\s+hectopascals/g, (match, num: string) => {
                const n = parseInt(num, 10);
                if (n >= 900 && n <= 1100) return `${pressureToWords(n)} hectopascals`;
                return match;
            })
            // Wind speed: "15 kt" / "15 kts" / "15 kn" → knots
            .replace(/(\d+(?:\.\d+)?)\s*kts?\b/g, '$1 knots')
            .replace(/(\d+(?:\.\d+)?)\s*kn\b/g, '$1 knots')
            // Distance: "5 nm" → "5 nautical miles" (only after a digit
            // + optional space, so we don't break "snm" in any words).
            .replace(/(\d+(?:\.\d+)?)\s*nm\b/g, '$1 nautical miles')
            // Length: "2.5 m" → "2.5 metres". Requires whitespace+digit
            // boundary so common words (I'm, room) don't match.
            .replace(/(\d+(?:\.\d+)?)\s+m\b(?!\w)/g, '$1 metres')
            // Wave period: "8 s" / "8s period" → "8 seconds". Same
            // boundary care — must follow a digit.
            .replace(/(\d+(?:\.\d+)?)\s*s\b(?=\s+(?:period|wave|swell)|\s*$|\s*[.,;])/gi, '$1 seconds')
    );
}

interface VoiceSettingsOverride {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    speed?: number;
    use_speaker_boost?: boolean;
}

interface AskBody {
    text?: string;
    voice_id?: string;
    /**
     * Optional per-call voice-settings override. Merged on top of
     * DEFAULT_VOICE_SETTINGS below. Use for emergency comms (MOB,
     * Mayday, DSC) that want slower + more deliberate delivery:
     *   { speed: 0.85, stability: 0.8 }
     * Casual chat omits this and gets the default cadence.
     */
    voice_settings?: VoiceSettingsOverride;
}

/**
 * Default ElevenLabs voice settings.
 *
 * Tuned 2026-05-16 after Shane reported Calypso sounding like
 * "introducing Taylor Swift to a concert full of prepubescent
 * teens" — i.e. too fast, too hype. Previous settings were
 * { stability: 0.5, similarity_boost: 0.75, style: 0.0, speed: 1.1 }.
 *
 * Changes:
 *  - speed 1.1 → 0.95   slightly slower than normal; matches radio
 *                       cadence; comfortable for marine reports.
 *  - stability 0.5 → 0.7  calmer, less emotive variation. Closer
 *                         to a measured professional than a hyped
 *                         announcer. 0.7 is the ElevenLabs sweet
 *                         spot for "natural but composed".
 *  - style 0.0          unchanged — already not exaggerated.
 *  - use_speaker_boost true  clarity bump for emergency comms;
 *                            barely noticeable for normal speech
 *                            but makes a difference when the
 *                            phone speaker is competing with
 *                            engine noise.
 *
 * Callers (e.g. MOB Speak Mayday) can override via the body's
 * voice_settings field for even more deliberate delivery.
 */
const DEFAULT_VOICE_SETTINGS = {
    stability: 0.7,
    similarity_boost: 0.75,
    style: 0.0,
    speed: 0.95,
    use_speaker_boost: true,
};

const clampSetting = (value: unknown, fallback: number, min: number, max: number): number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
};

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'method not allowed' }), {
            status: 405,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    const caller = await requireAuthenticatedQuota(req, 'elevenlabs_tts', 60, 3600);
    if (caller instanceof Response) {
        return withCors(caller, CORS);
    }

    const apiKey = Deno.env.get('ELEVENLABS_API_KEY');
    if (!apiKey) {
        console.error('[elevenlabs-tts] API key is not configured');
        return jsonResponse({ error: 'Speech service is not configured' }, 503, CORS);
    }

    const body = (await readJsonObject(req, 8_192)) as AskBody | null;
    if (!body) return jsonResponse({ error: 'Invalid request body' }, 400, CORS);

    const text = (body.text || '').trim();
    if (!text || text.length > 5000) {
        return new Response(JSON.stringify({ error: 'missing text' }), {
            status: 400,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    const voiceId = body.voice_id || Deno.env.get('ELEVENLABS_VOICE_ID') || DEFAULT_VOICE_ID;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(voiceId)) {
        return new Response(JSON.stringify({ error: 'invalid voice id' }), {
            status: 400,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }
    const requestedSettings = body.voice_settings ?? {};
    const voiceSettings = {
        ...DEFAULT_VOICE_SETTINGS,
        stability: clampSetting(requestedSettings.stability, DEFAULT_VOICE_SETTINGS.stability, 0, 1),
        similarity_boost: clampSetting(
            requestedSettings.similarity_boost,
            DEFAULT_VOICE_SETTINGS.similarity_boost,
            0,
            1,
        ),
        style: clampSetting(requestedSettings.style, DEFAULT_VOICE_SETTINGS.style, 0, 1),
        speed: clampSetting(requestedSettings.speed, DEFAULT_VOICE_SETTINGS.speed, 0.7, 1.2),
        use_speaker_boost:
            typeof requestedSettings.use_speaker_boost === 'boolean'
                ? requestedSettings.use_speaker_boost
                : DEFAULT_VOICE_SETTINGS.use_speaker_boost,
    };

    const t0 = Date.now();
    let upstream: Response;
    try {
        upstream = await fetchWithTimeout(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'xi-api-key': apiKey,
                    Accept: 'audio/mpeg',
                },
                body: JSON.stringify({
                    text: prepareForTTS(text),
                    model_id: 'eleven_flash_v2_5',
                    voice_settings: voiceSettings,
                }),
            },
            30_000,
        );
    } catch (error) {
        console.error('[elevenlabs-tts] Upstream request failed:', error);
        return jsonResponse({ error: 'Speech generation is temporarily unavailable' }, 502, CORS);
    }

    if (!upstream.ok) {
        const errBody = await readResponseTextLimited(upstream, 32_000);
        console.error(`[elevenlabs-tts] ${upstream.status}: ${(errBody ?? '').slice(0, 300)}`);
        return jsonResponse({ error: 'Speech generation is temporarily unavailable' }, 502, CORS);
    }

    const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('audio/')) {
        console.error(`[elevenlabs-tts] Unexpected upstream content type: ${contentType}`);
        return jsonResponse({ error: 'Speech service returned an invalid response' }, 502, CORS);
    }
    const arrayBuffer = await readResponseArrayBufferLimited(upstream, 10_000_000);
    if (!arrayBuffer) return jsonResponse({ error: 'Generated speech exceeded the size limit' }, 502, CORS);
    const bytes = new Uint8Array(arrayBuffer);
    const chunks: string[] = [];
    for (let i = 0; i < bytes.byteLength; i += 32_768) {
        chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32_768)));
    }
    const audio_b64 = btoa(chunks.join(''));

    return jsonResponse({ audio_b64, ms: Date.now() - t0 }, 200, CORS);
});
