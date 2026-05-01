// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * proxy-bosun-fallback — cloud Haiku 4.5 + tools for Thalassa's voice console.
 *
 * Pipeline:
 *   iOS records mic, does Web-Speech STT on-device, POSTs {text} here.
 *
 *   This function runs Haiku 4.5 in a tool-use loop with two tools:
 *     - web_search           Anthropic's native web search (live BoM, news, etc.)
 *     - thalassa_weather     Marine forecast via Open-Meteo (free, no key)
 *
 *   Final answer goes through ElevenLabs TTS (same HAL voice as Bosun) and
 *   returns {answer_text, audio_b64, source: "cloud", timings_ms}.
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
const MAX_TOOL_ITERATIONS = 4;

const SYSTEM_PROMPT = `You are Bosun, AI first mate aboard "Serene Summer", a 55-foot Tayana yacht (skippered by Shane Stratton).

You are answering from cloud fallback because the boat's local AI brain is unreachable. You do NOT have access to the boat's live instruments, Cerbo GX, or vessel-specific knowledge corpus. Be honest about that.

VESSEL FACTS (static, always true):
- Vessel: Serene Summer, 55-foot Tayana
- Engine: Perkins 6.3544 marine diesel (6-cylinder, ~1991)
- Electrical: 12V DC house + 240V AC + Victron Cerbo GX + MultiPlus + MPPT solar + Enerdrive B-TEC lithium
- Monitoring: YachtSense Link

TOOLS:
- thalassa_weather: USE THIS for any weather, wind, swell, sea state, or marine forecast question. Pass a location string like "Newport Qld" or lat/lng. Returns current conditions + 2-day forecast including marine wave data.
- web_search: USE THIS for news, current events, anything time-sensitive that thalassa_weather doesn't cover. Don't use for weather - that's what thalassa_weather is for.

When the skipper asks about weather/conditions: ALWAYS call thalassa_weather first. Synthesise the answer naturally - don't dump JSON. Round numbers sensibly (15kt SE not 14.83kt at 137°).

HONESTY RULES (these override everything):
1. You do NOT have live BOAT data right now (SOC, voltage, GPS position, depth). NEVER fabricate sensor readings. If asked, say: "I'm answering from shore — I can't read the boat's instruments. Tap the blue Bosun button for live readings."
2. The engine is a Perkins 6.3544. Never substitute Westerbeke, Yanmar, Volvo, or any other model.
3. For SAFETY-CRITICAL specs (torque, valve clearances, oil grades, fuel pressures, electrical voltages, anchor/rigging loads, medical doses): refuse to guess. Direct to the workshop manual or manufacturer.
4. For tool errors: relay the failure honestly. "I tried to look up the Newport Qld forecast but the weather service didn't respond."

STYLE:
- Address as "Cap'n"
- One or two sentences typically. Calm, competent, brief.
- No fabrication to seem helpful — honesty > apparent helpfulness.`;

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

async function callAnthropic(messages: AnthropicMessage[]): Promise<AnthropicResponse> {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: HAIKU_MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
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

async function callHaikuWithTools(userText: string): Promise<{ answer: string; ms: number }> {
    const t0 = Date.now();
    const messages: AnthropicMessage[] = [{ role: 'user', content: userText }];

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const response = await callAnthropic(messages);

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
            text,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0 },
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

// ── Edge Function entrypoint ───────────────────────────────────────────

interface AskRequest {
    text: string;
    session_id?: string;
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

    const text = (body.text || '').trim();
    if (!text) {
        return new Response(JSON.stringify({ error: "missing 'text'" }), {
            status: 400,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    try {
        const { answer, ms: llmMs } = await callHaikuWithTools(text);
        const { audio_b64, ms: ttsMs } = await callElevenLabs(answer);

        return new Response(
            JSON.stringify({
                transcript: text,
                answer_text: answer,
                audio_b64,
                source: 'cloud',
                timings_ms: {
                    total: Date.now() - totalStart,
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
