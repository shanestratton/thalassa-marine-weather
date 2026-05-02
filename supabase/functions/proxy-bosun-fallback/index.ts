// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * proxy-bosun-fallback — cloud Haiku 4.5 + tools for Thalassa's voice console.
 *
 * Pipeline:
 *   iOS records mic via MediaRecorder, POSTs {audio_b64, mime_type} here.
 *   STT runs server-side via ElevenLabs Scribe; transcript feeds Haiku 4.5
 *   in a tool-use loop with two tools:
 *     - web_search           Anthropic's native web search (live BoM, news, etc.)
 *     - thalassa_weather     Marine forecast via Open-Meteo (free, no key)
 *
 *   Final answer goes through ElevenLabs TTS (same HAL voice as Bosun) and
 *   returns {transcript, answer_text, audio_b64, source: "cloud", timings_ms}.
 *
 *   System prompt uses Anthropic prompt caching (ephemeral, 5-min TTL) so
 *   repeat queries within a session pay ~10% of base input cost.
 *
 * Required Supabase Secrets:
 *   ANTHROPIC_API_KEY      Anthropic API key (Haiku 4.5 access)
 *   ELEVENLABS_API_KEY     ElevenLabs API key
 *   ELEVENLABS_VOICE_ID    Voice ID (defaults to HAL clone if unset)
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const HAIKU_MODEL = 'claude-haiku-4-5';
const DEFAULT_VOICE_ID = 'Wq15xSaY3gWvazBRaGEU';
// 2 iterations = one tool call + final synthesis. Tighter than 4 to keep
// total round-trip well under the iOS 90s client timeout.
const MAX_TOOL_ITERATIONS = 2;

const SYSTEM_PROMPT = `You are Bosun, AI first mate aboard "Serene Summer", a 55-foot Tayana cutter skippered by Shane Stratton. You are the primary cloud brain — you reason about weather, marine knowledge, and general sailing topics, calling tools when they help.

A snapshot of what the skipper currently sees in the Thalassa app — selected location, the weather on their Glass page, any active passage plan — is appended to your context as "CURRENT THALASSA STATE" before each query. Read it. Answer against it when relevant. You do NOT have access to live boat instruments (battery SOC, depth, fuel, NMEA), and that snapshot does not contain them.

## VESSEL PROFILE

- Vessel: Serene Summer, 55-foot Tayana (cutter rig, bluewater cruiser)
- Engine: Perkins 6.3544 marine diesel (6-cylinder, ~1991)
- Electrical: 12V DC house bank + 240V AC + Victron Cerbo GX + MultiPlus inverter/charger + MPPT solar + Enerdrive B-TEC lithium
- Monitoring: YachtSense Link telemetry
- Home waters: Australian east coast (default geographic context unless the skipper indicates otherwise)
- Skipper: Shane — bluewater cruiser, conservative on offshore passages

These are the only vessel facts you can assert. Anything not on this list (sail inventory, tankage, rigging dimensions, polar diagram, draft, displacement, mast height) you do NOT know. If asked, say "I don't have that on record."

## TOOLS

You have two tools. Choose deliberately:

**thalassa_weather** — Marine forecast via Open-Meteo. USE FIRST for any weather, wind, swell, sea state, sea surface temperature, or marine forecast question. Accepts a location string ("Newport Qld", "Hamilton Island") OR explicit lat/lng. Returns current conditions plus 2-day forecast including wave data. Always call this before answering weather questions; never estimate from prior context.

**web_search** — Anthropic's native web search. USE for time-sensitive non-weather information: news, regulation changes, race results, marine notices outside thalassa_weather's coverage, manufacturer data lookups. Do NOT use for weather — that is thalassa_weather's job.

## HONESTY RULES — NON-NEGOTIABLE

Apparent helpfulness must never come at the cost of honesty. These rules override every other consideration.

1. **What you CAN see vs. what you CAN'T.** The Thalassa state snapshot gives you the skipper's selected location, the weather currently on their Glass page, and any active passage. Use that. You CANNOT read live boat instruments — battery SOC, voltage, depth, fuel level, water level, engine hours, alternator output, bilge state, masthead wind, NMEA sensors. If asked for any of those, say: "I can't read the boat's instruments from out here — that needs the Cerbo or YachtSense, not me." NEVER fabricate, infer, or estimate sensor values.

2. **The skipper's selected location ≠ the skipper's vessel position.** The location in the Thalassa snapshot is whatever the skipper has tapped or pinned in the app — it may be where they are, or it may be somewhere they're investigating. Don't assume "your position is X" from the snapshot; if they ask where they are, treat it as the selected location and say so plainly. Live GPS-vessel-position lives on the boat, not in this snapshot.

3. **Vessel facts beyond the profile are unknown.** Stick to the profile above. The engine is a Perkins 6.3544 — never substitute Westerbeke, Yanmar, Volvo Penta, or any other manufacturer. For sail inventory, tank capacities, rigging specs, mast height, and similar details: "I don't have that on record — check the vessel documents or your previous logs."

4. **Safety-critical numbers require a real source.** For torque values, valve clearances, oil grades, fuel pressures, electrical voltages, anchor and rigging working loads, sail dimensions, medical doses, tide heights, or anything where being wrong could hurt someone or damage the boat: refuse to guess. Direct to the workshop manual, manufacturer data sheet, or local pilot/almanac. "Best to check the manual on that one, Cap'n — I don't trust myself to be right within the safety margin."

5. **Tool failures get reported plainly.** If thalassa_weather returns an error, say so: "I tried the Newport Qld forecast but the weather service didn't respond — try again in a moment, or check BoM directly." Do not paper over tool failures with generic plausible-sounding answers.

6. **Hedge estimates explicitly.** When approximating, use hedge words: "around 15 knots", "roughly 4 hours", "I'd estimate". Never assert specific numbers you didn't get from a tool.

7. **Cite tool output with timestamp context.** When narrating thalassa_weather results, name the source and recency: "Per the latest Open-Meteo forecast for Newport Qld, current wind is 14 knots ESE — that's from a few minutes ago."

8. **Don't speculate beyond your training.** If asked about Serene Summer's specific quirks, prior maintenance history, or anything personal to this vessel beyond the profile, say "That's not something I have access to from out here."

## STYLE

- Address the skipper as "Cap'n".
- One or two sentences typically. Calm, competent, terse — like a watchstander reading a glass of water, not a chatbot trying to be friendly.
- No fabrication to seem helpful. Honesty over apparent helpfulness, always.
- Round numbers sensibly: "15 knots SE" not "14.83 knots at 137°". Use compass points (N, NE, E, SE…) rather than precise bearings unless the skipper asked for precision.
- When conditions are marginal or worsening, say so plainly. Don't soft-pedal weather that should give the skipper pause.
- Time references in skipper's local time when known.
- Marine vocabulary is fine — bowsprit, staysail, reefing, broaching, stem-the-tide. Don't dumb it down.
- **Don't repeat the vessel name "Serene Summer" in spoken responses.** Use "the boat", "your boat", "she", "aboard", or just speak about her in second person. The name sounds stilted when said often, and the TTS engine stumbles on it. At most ONCE per answer if the name is genuinely needed; otherwise omit entirely.`;

// ── Tool definitions ──────────────────────────────────────────────────

const TOOLS = [
    // Anthropic's native web search tool — runs server-side at Anthropic
    {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3,
    },
    // Custom Thalassa weather tool — Open-Meteo geocode + marine forecast
    {
        name: 'thalassa_weather',
        description:
            'Get current weather + 2-day marine forecast for a location. ' +
            'Returns wind speed/direction/gusts, temperature, precipitation, ' +
            'wave height/direction/period, and weather summary. ' +
            "Provide either lat/lng OR a location string (e.g. 'Newport Qld', " +
            "'Whitsundays', 'Sydney Heads').",
        input_schema: {
            type: 'object',
            properties: {
                location: {
                    type: 'string',
                    description: "Place name (e.g. 'Newport Qld', 'Hamilton Island')",
                },
                lat: { type: 'number', description: 'Latitude in decimal degrees' },
                lng: { type: 'number', description: 'Longitude in decimal degrees' },
            },
        },
    },
];

// ── Anthropic types ────────────────────────────────────────────────────

interface ContentBlock {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
}

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
}

interface AnthropicResponse {
    content: ContentBlock[];
    stop_reason: string;
    usage?: { input_tokens: number; output_tokens: number };
}

// ── Anthropic call ─────────────────────────────────────────────────────

async function callAnthropic(messages: AnthropicMessage[], stateBlock?: string): Promise<AnthropicResponse> {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    // Two-block system: cached vessel profile + per-request Thalassa state.
    // BP1 (vessel profile) carries cache_control so the static prefix hits
    // the prompt cache on warm calls. BP2 (state) intentionally has no
    // cache marker — it changes per request, and caching it would just
    // burn write cost.
    const systemBlocks: Array<Record<string, unknown>> = [
        {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
        },
    ];
    if (stateBlock && stateBlock.length > 0) {
        systemBlocks.push({ type: 'text', text: stateBlock });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: HAIKU_MODEL,
            // Cap output tightly. Voice answers should be 1-3 sentences;
            // 200 tokens is plenty and prevents Haiku from drifting long
            // (which directly translates to extra TTS time on the wire).
            max_tokens: 200,
            system: systemBlocks,
            tools: TOOLS,
            messages,
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Anthropic ${response.status}: ${body.slice(0, 300)}`);
    }
    return await response.json();
}

// ── Tool-use loop ──────────────────────────────────────────────────────

async function callHaikuWithTools(
    userText: string,
    context: ThalassaContext | undefined,
    history: VoiceHistoryTurn[] | undefined,
): Promise<{ answer: string; ms: number }> {
    const t0 = Date.now();
    const stateBlock = context ? formatStateBlock(context) : undefined;
    // Prior turns first (oldest → newest), then the current user message.
    // Anthropic requires alternating user/assistant; client + sanitizer
    // produce that shape, but if a stray duplicate slips through Anthropic
    // returns 400 which we surface as a Haiku error rather than guess.
    const priorMessages = sanitizeHistory(history);
    const messages: AnthropicMessage[] = [...priorMessages, { role: 'user', content: userText }];

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const response = await callAnthropic(messages, stateBlock);

        // Append assistant turn with all blocks (text + tool_use), so the
        // next request preserves the model's reasoning chain
        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason !== 'tool_use') {
            // Final answer — extract concatenated text
            const text = response.content
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text!)
                .join('')
                .trim();
            return { answer: text, ms: Date.now() - t0 };
        }

        // Execute client-side tools (thalassa_weather). Anthropic's web_search
        // executes server-side in their cluster — we don't see those calls,
        // their tool_result blocks are already in response.content.
        const toolResults: ContentBlock[] = [];
        for (const block of response.content) {
            if (block.type !== 'tool_use' || !block.name) continue;
            if (block.name === 'thalassa_weather') {
                const result = await runThalassaWeather((block.input || {}) as Record<string, unknown>);
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: result,
                    is_error: result.startsWith('ERROR:'),
                });
            }
        }

        if (toolResults.length === 0) {
            // Only built-in tools fired this turn (web_search). Anthropic
            // already produced text + tool_results inline; loop again so
            // the model can synthesise.
            continue;
        }

        messages.push({ role: 'user', content: toolResults });
    }

    return {
        answer: 'I tried calling tools too many times without resolving the question. Try rephrasing?',
        ms: Date.now() - t0,
    };
}

// ── Thalassa weather tool implementation ───────────────────────────────

interface GeocodeResult {
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    admin1?: string;
}

async function geocode(query: string): Promise<GeocodeResult | null> {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        query,
    )}&count=1&language=en&format=json`;
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const data = await r.json();
        const hit = data.results?.[0];
        if (!hit) return null;
        return {
            name: hit.name,
            latitude: hit.latitude,
            longitude: hit.longitude,
            country: hit.country,
            admin1: hit.admin1,
        };
    } catch {
        return null;
    }
}

async function fetchOpenMeteo(lat: number, lng: number): Promise<unknown> {
    const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
        `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,precipitation,pressure_msl` +
        `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,weather_code` +
        `&daily=temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,precipitation_sum` +
        `&forecast_days=2&timezone=auto&wind_speed_unit=kn`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    return await r.json();
}

async function fetchOpenMeteoMarine(lat: number, lng: number): Promise<unknown | null> {
    const url =
        `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}` +
        `&current=wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_direction,swell_wave_height,swell_wave_direction,swell_wave_period` +
        `&daily=wave_height_max,wind_wave_height_max,swell_wave_height_max&forecast_days=2&timezone=auto`;
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

async function runThalassaWeather(args: Record<string, unknown>): Promise<string> {
    let lat = typeof args.lat === 'number' ? args.lat : NaN;
    let lng = typeof args.lng === 'number' ? args.lng : NaN;
    let displayName = '';

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        const location = typeof args.location === 'string' ? args.location.trim() : '';
        if (!location) return 'ERROR: must provide either lat/lng or location';
        const geo = await geocode(location);
        if (!geo) return `ERROR: could not geocode "${location}"`;
        lat = geo.latitude;
        lng = geo.longitude;
        displayName = `${geo.name}${geo.admin1 ? ', ' + geo.admin1 : ''}, ${geo.country}`;
    } else {
        displayName = typeof args.location === 'string' ? args.location : `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
    }

    try {
        const [weather, marine] = await Promise.all([fetchOpenMeteo(lat, lng), fetchOpenMeteoMarine(lat, lng)]);
        return JSON.stringify({
            location: { name: displayName, lat, lng },
            atmospheric: weather,
            marine: marine ?? null,
            note:
                'Wind speeds are in knots. Times are local to the location. ' +
                'Marine fields may be null if the location is inland or outside coverage.',
        });
    } catch (err) {
        return `ERROR: weather fetch failed - ${(err as Error).message}`;
    }
}

// ── ElevenLabs TTS ─────────────────────────────────────────────────────

/**
 * Reshape the answer text right before TTS to smooth over known
 * pronunciation stumble points in ElevenLabs Flash. The system prompt
 * tells Haiku to avoid the vessel name, but if it slips through anyway
 * (or in legacy history-driven turns) we hyphenate it here so the model
 * treats "Serene Summer" as one phonetic unit instead of stalling on
 * an unfamiliar proper-noun pair.
 */
function prepareForTTS(text: string): string {
    return text.replace(/\bSerene Summer\b/g, 'Serene-Summer');
}

async function callElevenLabs(text: string): Promise<{ audio_b64: string | null; ms: number }> {
    const apiKey = Deno.env.get('ELEVENLABS_API_KEY');
    if (!apiKey) return { audio_b64: null, ms: 0 };
    const voiceId = Deno.env.get('ELEVENLABS_VOICE_ID') || DEFAULT_VOICE_ID;

    const t0 = Date.now();
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
            Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
            text: prepareForTTS(text),
            // Flash v2.5 is ElevenLabs' lowest-latency model — built for
            // real-time conversational use. Trades a sliver of voice
            // fidelity for materially faster generation than turbo.
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
                style: 0.0,
                // Speed multiplier: 1.0 = natural, 1.1 = a touch quicker.
                // Range 0.7-1.2 per ElevenLabs API.
                speed: 1.1,
            },
        }),
    });
    if (!response.ok) {
        console.error(`ElevenLabs ${response.status}:`, await response.text());
        return { audio_b64: null, ms: Date.now() - t0 };
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return { audio_b64: btoa(binary), ms: Date.now() - t0 };
}

// ── ElevenLabs Scribe (server-side STT for the voice path) ─────────────

async function elevenlabsScribe(audioB64: string, mimeType: string): Promise<{ text: string; ms: number }> {
    const apiKey = Deno.env.get('ELEVENLABS_API_KEY');
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured for STT');

    // Decode base64 → bytes
    const binary = atob(audioB64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Pick a filename extension Scribe will accept based on the iOS-side mime.
    const extension = mimeType.includes('webm')
        ? 'webm'
        : mimeType.includes('ogg')
          ? 'ogg'
          : mimeType.includes('mpeg')
            ? 'mp3'
            : 'm4a';

    const formData = new FormData();
    formData.append('file', new Blob([bytes], { type: mimeType }), `audio.${extension}`);
    formData.append('model_id', 'scribe_v1');
    formData.append('language_code', 'en');

    const t0 = Date.now();

    // Hard 30s ceiling on Scribe so a hung request can't burn the whole
    // function budget. Typical Scribe response is 1-3s.
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), 30_000);

    let response: Response;
    try {
        response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
            method: 'POST',
            headers: { 'xi-api-key': apiKey },
            body: formData,
            signal: ctrl.signal,
        });
    } catch (err) {
        const e = err as Error;
        if (e.name === 'AbortError') {
            throw new Error('Scribe timed out (30s) — STT service slow or audio rejected');
        }
        throw new Error(`Scribe network error: ${e.message}`);
    } finally {
        clearTimeout(watchdog);
    }

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Scribe ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = (await response.json()) as { text?: string };
    return { text: (data.text || '').trim(), ms: Date.now() - t0 };
}

// ── Edge Function entrypoint ───────────────────────────────────────────

// ── Thalassa state snapshot ────────────────────────────────────────────
//
// The iOS app bundles a snapshot of what the skipper currently sees in
// Thalassa with every request: selected location, Glass-section weather,
// active passage. This gets formatted into a state block and injected
// into the system prompt so Haiku has BP2-style "current state" alongside
// the cached static vessel profile.

interface ThalassaContextLocation {
    lat: number;
    lon: number;
    name: string;
    source: string;
    ageSec: number;
}

interface ThalassaContextConditions {
    locationName: string;
    windKt?: number;
    windDirDeg?: number;
    windDirCompass?: string;
    gustKt?: number;
    waveHeightM?: number;
    wavePeriodSec?: number;
    airTempC?: number;
    waterTempC?: number;
    pressureHpa?: number;
    humidityPct?: number;
    condition?: string;
    description?: string;
    source?: string;
    ageSec?: number;
}

interface ThalassaContextPassage {
    from: string;
    to: string;
    distanceNm: number;
    durationHours: number;
    departureTime?: string;
    arrivalTime?: string;
    maxWindKt?: number;
    maxWaveM?: number;
}

interface ThalassaContext {
    localTimeIso: string;
    location?: ThalassaContextLocation;
    conditions?: ThalassaContextConditions;
    passage?: ThalassaContextPassage;
}

interface VoiceHistoryTurn {
    role: 'user' | 'assistant';
    text: string;
}

interface AskRequest {
    text?: string;
    audio_b64?: string;
    mime_type?: string;
    session_id?: string;
    context?: ThalassaContext;
    /** Prior turns in this console session, oldest first. */
    history?: VoiceHistoryTurn[];
}

/**
 * Server-side cap on how many history turns we accept. The client also
 * caps; this is the belt-and-braces guard against a misbehaving caller
 * blowing up the prompt.
 */
const MAX_HISTORY_MESSAGES = 24;

function sanitizeHistory(history: VoiceHistoryTurn[] | undefined): AnthropicMessage[] {
    if (!Array.isArray(history)) return [];
    const out: AnthropicMessage[] = [];
    for (const turn of history) {
        if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
        if (typeof turn.text !== 'string') continue;
        const text = turn.text.trim();
        if (!text) continue;
        out.push({ role: turn.role, content: text });
    }
    // Cap from the end — keep the most recent turns when over the limit.
    if (out.length > MAX_HISTORY_MESSAGES) {
        return out.slice(out.length - MAX_HISTORY_MESSAGES);
    }
    return out;
}

// ── Render Thalassa state into a markdown block for the system prompt ──

function formatAge(sec: number | undefined): string {
    if (sec === undefined || !Number.isFinite(sec)) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    return `${Math.round(sec / 86400)}d ago`;
}

function formatStateBlock(ctx: ThalassaContext): string {
    const lines: string[] = [
        '## CURRENT THALASSA STATE',
        "(Snapshot from the skipper's phone, sent with this request)",
        '',
    ];

    lines.push(`Skipper local time: ${ctx.localTimeIso}`);

    if (ctx.location) {
        const { lat, lon, name, source, ageSec } = ctx.location;
        const sourceLabel =
            source === 'gps'
                ? 'GPS'
                : source === 'map_pin'
                  ? 'a long-press pin on the map'
                  : source === 'search'
                    ? 'a search'
                    : source === 'favorite'
                      ? 'a saved favorite'
                      : 'app default';
        lines.push('');
        lines.push(
            `Selected location: ${name} (${lat.toFixed(4)}, ${lon.toFixed(4)}), set from ${sourceLabel} ${formatAge(ageSec)}.`,
        );
    }

    if (ctx.conditions) {
        const c = ctx.conditions;
        const bits: string[] = [];
        if (typeof c.windKt === 'number') {
            const dir = c.windDirCompass ?? (typeof c.windDirDeg === 'number' ? `${c.windDirDeg}°` : '');
            const gust = typeof c.gustKt === 'number' ? `, gust ${c.gustKt.toFixed(0)} kt` : '';
            bits.push(`wind ${c.windKt.toFixed(0)} kt ${dir}${gust}`.trim());
        }
        if (typeof c.waveHeightM === 'number') {
            const period = typeof c.wavePeriodSec === 'number' ? ` at ${c.wavePeriodSec.toFixed(0)}s` : '';
            bits.push(`wave ${c.waveHeightM.toFixed(1)}m${period}`);
        }
        if (typeof c.airTempC === 'number') bits.push(`air ${c.airTempC.toFixed(0)}°C`);
        if (typeof c.waterTempC === 'number') bits.push(`water ${c.waterTempC.toFixed(0)}°C`);
        if (typeof c.pressureHpa === 'number') bits.push(`pressure ${c.pressureHpa.toFixed(0)} hPa`);
        if (typeof c.humidityPct === 'number') bits.push(`humidity ${c.humidityPct.toFixed(0)}%`);
        if (c.description) bits.push(c.description);

        if (bits.length > 0) {
            lines.push('');
            lines.push(`Current conditions at ${c.locationName} (Glass section):`);
            lines.push(`- ${bits.join(', ')}`);
            if (c.source) lines.push(`- Source: ${c.source}, ${formatAge(c.ageSec)}`);
        }
    }

    if (ctx.passage) {
        const p = ctx.passage;
        lines.push('');
        lines.push(`Active passage plan: ${p.from} → ${p.to}`);
        lines.push(`- ${p.distanceNm.toFixed(0)} nm, ~${p.durationHours.toFixed(0)} hrs`);
        if (p.departureTime) lines.push(`- Departs: ${p.departureTime}`);
        if (p.arrivalTime) lines.push(`- Arrives: ${p.arrivalTime}`);
        if (typeof p.maxWindKt === 'number') lines.push(`- Max forecast wind: ${p.maxWindKt.toFixed(0)} kt`);
        if (typeof p.maxWaveM === 'number') lines.push(`- Max forecast wave: ${p.maxWaveM.toFixed(1)} m`);
    }

    lines.push('');
    lines.push(
        'NOTE: This state reflects what the skipper sees in the Thalassa app on their phone — selected location, weather they are looking at, planned passage. It is NOT live boat instruments — battery SOC, depth, fuel, engine state and similar sensor values are not in this snapshot and you cannot read them from the cloud.',
    );

    return lines.join('\n');
}

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

    const totalStart = Date.now();
    let body: AskRequest;
    try {
        body = await req.json();
    } catch {
        return new Response(JSON.stringify({ error: 'invalid JSON' }), {
            status: 400,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    // Resolve transcript: typed text directly, OR Scribe STT on the audio blob.
    let transcript = (body.text || '').trim();
    let sttMs = 0;

    if (!transcript) {
        if (!body.audio_b64) {
            return new Response(JSON.stringify({ error: "missing 'text' or 'audio_b64'" }), {
                status: 400,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }
        try {
            const stt = await elevenlabsScribe(body.audio_b64, body.mime_type || 'audio/mp4');
            transcript = stt.text;
            sttMs = stt.ms;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('Scribe STT failed:', message);
            return new Response(JSON.stringify({ error: `Speech recognition failed: ${message}` }), {
                status: 500,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }
        if (!transcript) {
            // STT returned nothing — silence or unintelligible audio.
            return new Response(
                JSON.stringify({
                    transcript: '',
                    answer_text: "I couldn't hear what you said — try again, Cap'n.",
                    audio_b64: null,
                    source: 'cloud',
                    timings_ms: { total: Date.now() - totalStart, stt: sttMs },
                }),
                { headers: { ...CORS, 'Content-Type': 'application/json' } },
            );
        }
    }

    try {
        const { answer, ms: llmMs } = await callHaikuWithTools(transcript, body.context, body.history);
        const { audio_b64, ms: ttsMs } = await callElevenLabs(answer);

        return new Response(
            JSON.stringify({
                transcript,
                answer_text: answer,
                audio_b64,
                source: 'cloud',
                timings_ms: {
                    total: Date.now() - totalStart,
                    stt: sttMs,
                    llm: llmMs,
                    tts: ttsMs,
                },
            }),
            { headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('proxy-bosun-fallback failed:', message);
        return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }
});
