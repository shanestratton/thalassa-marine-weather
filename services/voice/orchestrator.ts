/**
 * orchestrator — client-side Haiku tool-use loop.
 *
 * This is the Path A "iPhone is the orchestrator" architecture from
 * docs/BOSUN_HAIKU_ARCHITECTURE.md and docs/BOSUN_TOOL_API.md. The iOS
 * app:
 *   1. Builds the Anthropic request (system prompt + history + user).
 *   2. POSTs to the `anthropic-proxy` edge function (thin forwarder).
 *   3. If Haiku returns tool_use blocks, dispatches them on-device:
 *        - Pi tools (get_vessel_state, search_manuals, …) → POST to
 *          http://${piHost}:5000/tool/${name} via piTools.executePiTool
 *        - thalassa_weather → cloudTools.runThalassaWeather (direct
 *          Open-Meteo call from the device)
 *        - web_search → Anthropic's server-side tool, no client work
 *   4. Sends tool_result blocks back as a new user message and loops.
 *   5. On a non-tool-use response, returns the final answer text.
 *
 * Why this lives on the device instead of the edge function:
 *   - Pi-local tools run on the boat's LAN and the edge function can't
 *     reach 192.168.50.150 from Cloudflare. The iPhone can.
 *   - Tool-use round trips cost 2x request latency to the edge function.
 *     Running locally cuts that.
 *   - The edge function becomes a thin pass-through (anthropic-proxy +
 *     elevenlabs-tts), much smaller blast radius for changes.
 *
 * The Anthropic API key STAYS on the server side via anthropic-proxy.
 * The orchestrator never holds it.
 */

import type { ThalassaContext, VoiceHistoryTurn } from '../../types/voice';
import { runThalassaWeather } from './cloudTools';
import { executePiTool, isBosunWebReachable, isPiToolName } from './piTools';

const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
const SUPABASE_KEY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';

const HAIKU_MODEL = 'claude-haiku-4-5';
/**
 * Cap on tool round-trips per skipper query. 2 = "one tool call +
 * final synthesis". Tightened from 3 because each round-trip is a
 * separate /v1/messages call, which counts against per-minute rate
 * limits — 3 messages × 3 iterations = 9 calls and the skipper
 * starts hitting 429s on Tier 1. With 2 iterations and prompt caching
 * we should comfortably stay inside any reasonable RPM budget.
 */
const MAX_TOOL_ITERATIONS = 2;
/**
 * Backoff schedule for 429 rate-limit retries. Two attempts with
 * increasing delays so we ride out short Anthropic throttle bursts
 * (which can fire when the orchestrator does 2 calls per skipper
 * query and the skipper is testing in rapid succession). Total
 * worst-case blocking before surfacing the error: ~5.5s.
 */
const RATE_LIMIT_BACKOFFS_MS = [1500, 4000];
/**
 * Per Anthropic round-trip ceiling. The proxy enforces 90s upstream;
 * we add JS-side abort on top of fetch for parity with bosunVoice's
 * pattern (ios CapacitorHttp can hang otherwise).
 */
const ANTHROPIC_REQUEST_TIMEOUT_MS = 90_000;
const TTS_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Bound history sent over the wire. UI keeps more for scroll-back; this
 * is the slice Haiku actually sees per call.
 */
const HISTORY_TURN_LIMIT = 4;

// ── Anthropic request types (subset we need) ───────────────────

interface ContentBlock {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
    cache_control?: { type: 'ephemeral' };
}

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
}

interface AnthropicResponse {
    content: ContentBlock[];
    stop_reason: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
}

interface ToolDef {
    name?: string;
    type?: string;
    description?: string;
    input_schema?: unknown;
    max_uses?: number;
    /** Anthropic prompt-cache marker — set on the LAST tool to cache the array. */
    cache_control?: { type: 'ephemeral' };
}

// ── Tool registry ──────────────────────────────────────────────

/** Always-available tools regardless of Pi reachability. */
const CLOUD_TOOLS: ToolDef[] = [
    {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3,
    },
    {
        name: 'thalassa_weather',
        description:
            'Get current weather + 2-day marine forecast for a location. Returns wind speed/direction/gusts, ' +
            'temperature, precipitation, wave height/direction/period, and weather summary. Provide either ' +
            "lat/lng OR a location string (e.g. 'Newport Qld', 'Whitsundays', 'Sydney Heads').",
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

/**
 * Pi tool descriptions — only registered when the Pi is reachable.
 * Field names match what the Pi actually returns per BOSUN_TOOL_API.md
 * §"Deviation from architecture doc" — we tell Haiku what it'll see,
 * not what the older architecture doc said.
 */
const PI_TOOLS: ToolDef[] = [
    {
        name: 'get_vessel_position',
        description:
            "Read the boat's current GPS position from SignalK. Returns lat/lon, heading_deg_true, " +
            'sog_kt (speed over ground in knots), cog_deg_true (course over ground). ' +
            "Returns value:null with an error string if the GPS hasn't reported yet.",
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_vessel_state',
        description:
            "Read the boat's live instruments: wind apparent and true (each as _speed_kt + _angle_deg), " +
            'depth_m, water_temp_c, fuel_pct, fresh_water_pct, engine_hours, batt_soc_pct, batt_voltage_v. ' +
            'Combines SignalK environmental + Victron Modbus battery. Any missing field comes back null; ' +
            'the rest still arrive.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_vessel_profile',
        description:
            "Read the static vessel profile: nested fields under 'vessel' (make, model, loa_m, draft_m, " +
            "displacement_kg, …), 'engine' (make, model, horsepower, fuel), 'electrical', 'tankage', 'sails', " +
            "'owner'. Use this when the skipper asks about the boat's specs that aren't covered by the " +
            'system prompt.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'search_manuals',
        description:
            "Semantic search over the boat's manual library: Perkins 6.3544, Victron MultiPlus 3k + MPPT + " +
            'Orion XS + Cerbo GX, Enerdrive B-TEC lithium, AS/NZS 3001 fitting. Returns top-k chunks with ' +
            'source path, heading, and similarity score (lower=closer). USE THIS for any question about ' +
            'manufacturer specs, torque values, fault codes, wiring details — anything that should come ' +
            'from the documentation rather than your training.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural-language search query.' },
                k: { type: 'number', description: 'Number of chunks to return (default 5).' },
            },
            required: ['query'],
        },
    },
];

// ── System prompt builder ──────────────────────────────────────

const VESSEL_NAME = 'Serene Summer';
const ASSISTANT_NAME = 'Calypso';

const STATIC_SYSTEM_PROMPT = `You are ${ASSISTANT_NAME}, AI first mate aboard "${VESSEL_NAME}", a 55-foot Tayana cutter skippered by Shane Stratton. (You may have answered to "Bosun" in earlier conversations — that was the old name; you are Calypso now. If the skipper calls you Bosun, gently let them know you go by Calypso these days, but never make a fuss of it.) You reason about weather, marine knowledge, and general sailing topics, calling tools when they help.

A snapshot of what the skipper currently sees in the Thalassa app — selected location, the weather on their Glass page, any active passage plan — is appended to your context as "CURRENT THALASSA STATE" before each query. Read it. Answer against it when relevant.

When the boat-side Pi is reachable, you have additional tools that read LIVE vessel instruments (\`get_vessel_position\`, \`get_vessel_state\`), the static vessel profile (\`get_vessel_profile\`), and a marine knowledge corpus (\`search_manuals\`). Call them when the skipper asks for something they cover. When those tools are NOT in your registry, the Pi is unreachable and you only have the Thalassa snapshot to work from — be honest about that boundary.

## VESSEL PROFILE (static, always true)

- Vessel: ${VESSEL_NAME}, 55-foot Tayana (cutter rig, bluewater cruiser)
- Engine: Perkins 6.3544 marine diesel (6-cylinder, ~1991)
- Electrical: 12V DC house bank + 240V AC + Victron Cerbo GX + MultiPlus inverter/charger + MPPT solar + Enerdrive B-TEC lithium
- Monitoring: YachtSense Link telemetry
- Home waters: Australian east coast (default geographic context unless the skipper indicates otherwise)
- Skipper: Shane — bluewater cruiser, conservative on offshore passages

For details beyond this list (sail inventory, tankage, rigging dimensions, polar diagram, mast height) call \`get_vessel_profile\` if available, otherwise say "I don't have that on record."

## HONESTY RULES — NON-NEGOTIABLE

Apparent helpfulness must never come at the cost of honesty. These rules override every other consideration.

1. **What you CAN see vs. what you CAN'T.** When Pi tools are registered you can read live battery SOC, fuel, depth, position, etc. via \`get_vessel_state\` and \`get_vessel_position\`. Call those tools rather than estimating. When the Pi is unreachable, the only live data is the Thalassa state snapshot — say plainly "I can't read the boat's instruments from out here" and don't invent values.

2. **The skipper's selected location ≠ the skipper's vessel position.** The location in the Thalassa snapshot is whatever the skipper has tapped or pinned in the app. If they ask "where am I" and \`get_vessel_position\` is available, USE IT. Otherwise treat the snapshot location as the selected location and say so.

3. **Use search_manuals when the answer should come from documentation.** Torque specs, fault codes, wiring details, voltages — call \`search_manuals\` and quote the chunk. Don't recall from training.

4. **Safety-critical numbers require a real source.** For torque values, valve clearances, oil grades, fuel pressures, electrical voltages, anchor and rigging working loads, sail dimensions, medical doses, tide heights: call \`search_manuals\` first. If nothing relevant comes back, refuse to guess and direct to the workshop manual or local pilot.

5. **Tool failures get reported plainly.** If a tool returns value:null with an error, narrate it: "I tried to read the fuel level but the Pi says: <error>". Don't paper over with a guess.

6. **Hedge estimates explicitly.** When approximating, use hedge words: "around 15 knots", "roughly 4 hours". Never assert specific numbers you didn't get from a tool.

7. **Cite tool output with timestamp context.** When narrating thalassa_weather or Pi tool results, name the source and recency: "Per the latest Open-Meteo forecast for Newport Qld…" or "From SignalK 30 seconds ago, your batteries are at…".

8. **Don't speculate beyond your training.** For Serene Summer's specific quirks, prior maintenance history, or anything personal to this vessel beyond the profile + manuals, say "That's not something I have access to."

## STYLE

- Address the skipper as "Cap'n".
- One or two sentences typically. Calm, competent, terse — like a watchstander reading a glass of water, not a chatbot trying to be friendly.
- No fabrication to seem helpful. Honesty over apparent helpfulness, always.
- When conditions are marginal or worsening, say so plainly. Don't soft-pedal.
- Marine vocabulary is fine — bowsprit, staysail, reefing, broaching, stem-the-tide.
- **Don't repeat the vessel name "${VESSEL_NAME}" in spoken responses.** Use "the boat", "your boat", "she", "aboard". The name sounds stilted when said often, and TTS stumbles on it. At most ONCE per answer if genuinely needed.

## UNITS — METRIC + MARINE STANDARD, ALWAYS

The skipper is Australian and the boat operates on metric and marine conventions. Use these units, never imperial equivalents, never SI prefixes the skipper wouldn't use on the bridge:

- **Wind speed**: knots (not km/h, not m/s, not mph). "15 knots", "gusting 25".
- **Boat speed / current**: knots.
- **Distance over water**: nautical miles (nm) for >1nm, metres (m) for <1nm. Never kilometres.
- **Depth**: metres. "12 m of water", "anchored in 8 m".
- **Wave / swell height**: metres. "1.5 m swell at 8 seconds".
- **Wave / swell period**: seconds. "8 second period".
- **Air temperature**: degrees Celsius. "22 °C".
- **Water / sea surface temperature**: degrees Celsius.
- **Atmospheric pressure**: hectopascals (hPa). "1015 hPa", "pressure dropping through 1010".
- **Time durations**: minutes / hours, with seconds for short events. "in about 40 minutes", "20 minute squall", "ETA 6 hours".
- **Time of day**: skipper's local time when known. 24-hour clock fine ("departs 14:30") or natural language ("late afternoon").
- **Fuel / water tankage**: percent or litres. "fuel at 60%", "water 180 L".
- **Visibility**: nautical miles or metres. "8 nm visibility", "300 m in fog".

## COMPASS DIRECTIONS — 16-POINT, NEVER DEGREES

For wind, swell, course, and bearing, use 16-point compass abbreviations: N, NNE, NE, ENE, E, ESE, SE, SSE, S, SSW, SW, WSW, W, WNW, NW, NNW. Spell out the cardinals as words when reading aloud feels natural ("south-easterly 18 knots") but never use degrees ("137°") — they're hard to picture from voice and the TTS stumbles on the degree symbol.

- "south-easterly 18 knots" or "SE 18" — both fine
- "wind backing from NE to NNE" — describe shifts using compass points
- "swell from the SW at 1.2 m" — direction comes BEFORE the magnitude

For directions of motion (vessel heading, current set, weather system tracking) the same convention. "Tracking ENE", "current setting south", "course 045 north-east" if you need precision.

## NUMERIC ROUNDING

Round sensibly to what the skipper actually cares about:
- Wind: nearest knot ("15 knots" not "14.7"). Gusts to nearest 5 knots.
- Wave height: 0.1 metre precision ("1.5 metres" not "1.47 metres").
- Pressure: nearest whole hectopascal ("1015 hectopascals" not "1015.4").
- Temperature: nearest degree.
- Time: minutes for under an hour, hours for longer ("about 4 hours", not "3.7 hours").
- Distances: 0.1 nautical mile under 5 nautical miles, whole nautical miles above.

When a tool returns more precision than this, narrate the rounded version.

## PHONE GPS — FALLBACK FOR VESSEL POSITION

When the boat-side Pi is unreachable (no \`get_vessel_position\` tool), the state snapshot includes a "Phone GPS" block — that's the iPhone's reported position. Treat it as a reasonable proxy for vessel position: the phone is on the boat, GPS resolves to within metres of where the boat actually is.

Use Phone GPS for any question that needs current location: "where am I", "what's the weather here", "how far to Mooloolaba", "are we still in Moreton Bay". When you reply:

- If the snapshot includes a \`Near X\` place name (reverse-geocoded), use the place name in your spoken reply: "We're near Newport, Queensland." NEVER read raw decimal coordinates aloud when a place name is available — TTS stumbles on degree-decimal numbers and the skipper has to mentally convert anyway.
- If there's no place name (offshore — reverse geocoder returned nothing), THEN read the coordinates: "27.2 degrees south, 153.1 east." Round to one decimal.
- If the GPS is moving at >0.5 knots, mention the speed and heading: "Tracking SE at 5.2 knots."
- If the GPS fix is older than 5 minutes, say so plainly: "Last fix was about 8 minutes ago — phone signal might be patchy."

When the Pi tool \`get_vessel_position\` IS available (Pi link ON-BOAT), prefer it — that reads from SignalK on the actual boat instruments, more authoritative than the phone. Phone GPS is the offline backup.

## TTS-FRIENDLY OUTPUT — UNITS AS FULL WORDS

Your replies are spoken via ElevenLabs Flash TTS, which mispronounces unit abbreviations and the degree symbol. ALWAYS write units as full words, never abbreviations or symbols. The TTS pipeline has a backup transformer that catches the common ones, but writing them out from the start gives the cleanest audio:

- "1020 hectopascals" — NEVER "1020 hPa" (TTS reads "huppa")
- "22 degrees Celsius" — NEVER "22°C" or "22 C" (TTS reads "decess")
- "2.5 metres" — NEVER "2.5 m" (TTS reads "minutes")
- "8 second period" — NEVER "8 s" (TTS reads as a single letter)
- "15 knots" — NEVER "15 kt" or "15 kts"
- "5 nautical miles" — NEVER "5 nm"
- "south-easterly", "north-westerly", or "SE", "NW" — both fine for compass directions; TTS handles compass abbreviations correctly.

Numbers themselves stay as digits ("1020", "22", "2.5"). The TTS reads digits naturally. It's the UNIT AFTER the number that needs to be the full spelled-out word.`;

function ageString(sec: number | undefined): string {
    if (sec === undefined || !Number.isFinite(sec)) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    return `${Math.round(sec / 86400)}d ago`;
}

function formatStateBlock(ctx: ThalassaContext, piReachable: boolean): string {
    const lines: string[] = [
        '## CURRENT THALASSA STATE',
        "(Snapshot from the skipper's phone, sent with this request)",
    ];
    lines.push('');
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
            `Selected location: ${name} (${lat.toFixed(4)}, ${lon.toFixed(4)}), set from ${sourceLabel} ${ageString(ageSec)}.`,
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
            if (c.source) lines.push(`- Source: ${c.source}, ${ageString(c.ageSec)}`);
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

    if (ctx.phoneGps) {
        const g = ctx.phoneGps;
        lines.push('');
        lines.push('Phone GPS (the iPhone):');
        if (g.place) {
            lines.push(`- Near ${g.place} (${g.lat.toFixed(4)}, ${g.lon.toFixed(4)})`);
        } else {
            lines.push(`- ${g.lat.toFixed(4)}, ${g.lon.toFixed(4)} (offshore — no nearby place name)`);
        }
        if (typeof g.speedKt === 'number' && g.speedKt > 0.5) {
            const heading = typeof g.headingDeg === 'number' ? `, heading ${g.headingDeg}°` : '';
            lines.push(`- Moving at ${g.speedKt.toFixed(1)} knots${heading}`);
        }
        lines.push(`- Accuracy ±${g.accuracyM}m, fix ${ageString(g.ageSec)}`);
    }

    lines.push('');
    if (piReachable) {
        lines.push(
            'Pi link: ON-BOAT, reachable. You have live vessel tools (get_vessel_position, get_vessel_state, get_vessel_profile, search_manuals). Use them for anything the snapshot above does not cover.',
        );
    } else {
        lines.push(
            'Pi link: OFFLINE or unreachable. The snapshot above is all the live data you have — battery SOC, depth, fuel, engine state, and the boat manuals are NOT available this turn. ' +
                (ctx.phoneGps
                    ? 'Use Phone GPS as a fallback for vessel position when the skipper asks where they are or any question that needs current location.'
                    : ''),
        );
    }

    return lines.join('\n');
}

// ── Anthropic POST helper ──────────────────────────────────────

/**
 * Single attempt — used by postAnthropic which adds a one-shot retry on
 * 429. Returns a discriminated result instead of throwing on rate-limit
 * so the retry decision lives in one place.
 */
async function postAnthropicAttempt(
    body: object,
): Promise<{ kind: 'ok'; response: AnthropicResponse } | { kind: 'err'; status: number; message: string }> {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return { kind: 'err', status: 0, message: 'Anthropic proxy not configured (missing Supabase credentials).' };
    }
    const url = `${SUPABASE_URL}/functions/v1/anthropic-proxy`;
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), ANTHROPIC_REQUEST_TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_KEY}`,
                apikey: SUPABASE_KEY,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!r.ok) {
            const errText = await r.text();
            return { kind: 'err', status: r.status, message: errText.slice(0, 300) };
        }
        return { kind: 'ok', response: (await r.json()) as AnthropicResponse };
    } catch (err) {
        const e = err as Error;
        if (e.name === 'AbortError') {
            return {
                kind: 'err',
                status: 0,
                message: `Haiku request timed out after ${Math.round(ANTHROPIC_REQUEST_TIMEOUT_MS / 1000)}s.`,
            };
        }
        return { kind: 'err', status: 0, message: e.message || 'Unknown transport error' };
    } finally {
        clearTimeout(watchdog);
    }
}

async function postAnthropic(body: object): Promise<AnthropicResponse> {
    let result = await postAnthropicAttempt(body);
    // 429 = rate-limited. Two retries with increasing backoff smooth
    // over transient throttle without burning the skipper. Beyond two
    // retries we surface the actual proxy message so they can see
    // whether it's RPM, input-TPM, or spend-cap.
    for (const delayMs of RATE_LIMIT_BACKOFFS_MS) {
        if (result.kind !== 'err' || result.status !== 429) break;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        result = await postAnthropicAttempt(body);
    }
    if (result.kind === 'ok') return result.response;
    // Friendly, source-specific error messages so the skipper knows
    // exactly which provider is the bottleneck without parsing JSON.
    // The raw `result.message` is the body text Anthropic returned;
    // we sniff for known error shapes and rewrite.
    const lcMessage = (result.message || '').toLowerCase();
    if (result.status === 429) {
        throw new Error('Anthropic rate limit — too many requests in a short window. Wait 30 seconds and try again.');
    }
    if (lcMessage.includes('quota') || lcMessage.includes('credit balance') || lcMessage.includes('billing')) {
        throw new Error(
            "Anthropic monthly quota exhausted on this account — top up at https://console.anthropic.com/settings/billing or wait until next month's reset.",
        );
    }
    if (lcMessage.includes('overloaded')) {
        throw new Error('Anthropic is currently overloaded — try again in a moment.');
    }
    if (result.status === 401 || result.status === 403) {
        throw new Error('Anthropic auth failed — the API key on the server is invalid or revoked.');
    }
    const statusBit = result.status > 0 ? `${result.status}` : 'transport';
    throw new Error(`Anthropic proxy ${statusBit}: ${result.message.slice(0, 120)}`);
}

// ── TTS helper ─────────────────────────────────────────────────

/**
 * Last-known ElevenLabs failure surfaced to the BosunConsole. We don't
 * THROW from synthesiseSpeech because the answer text is still useful
 * even with no audio — but the console wants to be able to surface
 * "TTS quota exhausted" as a transient toast rather than just showing
 * a silent answer with no replay button.
 */
let lastTtsErrorMessage: string | null = null;
export function consumeLastTtsError(): string | null {
    const v = lastTtsErrorMessage;
    lastTtsErrorMessage = null;
    return v;
}

export async function synthesiseSpeech(text: string): Promise<string | null> {
    if (!SUPABASE_URL || !SUPABASE_KEY) return null;
    const url = `${SUPABASE_URL}/functions/v1/elevenlabs-tts`;
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), TTS_REQUEST_TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_KEY}`,
                apikey: SUPABASE_KEY,
            },
            body: JSON.stringify({ text }),
            signal: ctrl.signal,
        });
        if (!r.ok) {
            // Capture quota / billing errors so the console can surface
            // a real toast instead of silently returning text-only.
            const body = await r.text().catch(() => '');
            const lc = body.toLowerCase();
            if (lc.includes('quota') || lc.includes('credit')) {
                lastTtsErrorMessage =
                    'ElevenLabs TTS quota exhausted — Calypso will reply in text only. Top up at https://elevenlabs.io/account/billing.';
            } else if (r.status === 401 || r.status === 403) {
                lastTtsErrorMessage = 'ElevenLabs auth failed — Calypso replies will be text only.';
            } else {
                lastTtsErrorMessage = `ElevenLabs TTS failed (${r.status}) — Calypso replies will be text only this turn.`;
            }
            return null;
        }
        const data = (await r.json()) as { audio_b64?: string };
        return data.audio_b64 ?? null;
    } catch (err) {
        const e = err as Error;
        if (e.name !== 'AbortError') {
            lastTtsErrorMessage = `ElevenLabs TTS unreachable — text-only this turn.`;
        }
        return null;
    } finally {
        clearTimeout(watchdog);
    }
}

// ── Tool dispatcher ────────────────────────────────────────────

async function dispatchTool(
    name: string,
    input: Record<string, unknown>,
    piReachable: boolean,
): Promise<{ content: string; isError: boolean }> {
    if (name === 'thalassa_weather') {
        const result = await runThalassaWeather(input);
        return { content: result.content, isError: result.isError };
    }
    if (isPiToolName(name)) {
        if (!piReachable) {
            return {
                content: JSON.stringify({ error: 'Pi link dropped mid-conversation; tool unavailable.' }),
                isError: true,
            };
        }
        const result = await executePiTool(name, input);
        return { content: result.content, isError: result.is_error };
    }
    // web_search runs server-side at Anthropic; we never see its
    // tool_use blocks here. If we do, that's a registry/upstream
    // mismatch — surface it as an error rather than silently swallow.
    return {
        content: JSON.stringify({ error: `Unknown tool '${name}'` }),
        isError: true,
    };
}

// ── Public API ─────────────────────────────────────────────────

export interface OrchestratorResult {
    /** The final answer text Haiku produced. */
    answerText: string;
    /** Names of tools that were dispatched, in order. For UI / debug. */
    toolCalls: string[];
    /** Number of /v1/messages round trips. */
    iterations: number;
    /** True when the Pi was reachable at the start of this query. */
    piWasReachable: boolean;
}

export interface AskHaikuInput {
    text: string;
    context: ThalassaContext;
    history: VoiceHistoryTurn[];
}

/**
 * Run the full client-side tool-use loop for one skipper query. Returns
 * the final answer text plus a small audit trail. Caller is responsible
 * for converting the answer to audio (synthesiseSpeech) and surfacing
 * it via the voice console.
 */
export async function askHaiku(input: AskHaikuInput): Promise<OrchestratorResult> {
    const piReachable = await isBosunWebReachable();
    // Mark the last tool with cache_control:ephemeral so Anthropic caches
    // the whole tools array as a separate cache breakpoint. Tools array
    // changes only when Pi reachability flips — within a 5-minute window
    // of consistent connectivity, every call after the first reads tools
    // from the cache at 10% of base cost. With 6 tools when Pi is
    // reachable (~1500 input tokens), this is a meaningful ITPM
    // reduction — should help the skipper avoid the per-minute caps
    // they were hitting at 3 conversations.
    const baseTools = piReachable ? [...CLOUD_TOOLS, ...PI_TOOLS] : CLOUD_TOOLS;
    const tools: ToolDef[] =
        baseTools.length > 0
            ? [
                  ...baseTools.slice(0, -1),
                  { ...baseTools[baseTools.length - 1], cache_control: { type: 'ephemeral' as const } },
              ]
            : baseTools;

    const stateBlock = formatStateBlock(input.context, piReachable);
    const systemBlocks = [
        {
            type: 'text',
            text: STATIC_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' as const },
        },
        // BP2: per-request state. Not cached — changes every call.
        { type: 'text', text: stateBlock },
    ];

    // Sanitize history: alternating user/assistant, no empties.
    const recent = input.history.slice(-HISTORY_TURN_LIMIT * 2);
    const messages: AnthropicMessage[] = [];
    for (const turn of recent) {
        if (!turn) continue;
        if (turn.role !== 'user' && turn.role !== 'assistant') continue;
        const text = (turn.text || '').trim();
        if (!text) continue;
        messages.push({ role: turn.role, content: text });
    }
    messages.push({ role: 'user', content: input.text });

    const toolCalls: string[] = [];
    let iterations = 0;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        iterations++;
        // On the FINAL iteration, force tool_choice:'none' so Haiku
        // synthesises a text answer from whatever tool_results it
        // already has — instead of asking for more tools we don't have
        // budget for. Without this guard the loop ran out and we
        // returned a canned "called tools too many times" message,
        // which is a worse skipper experience than a slightly
        // less-informed but real answer.
        const isFinalIteration = i === MAX_TOOL_ITERATIONS - 1;
        const response = await postAnthropic({
            model: HAIKU_MODEL,
            max_tokens: 200,
            system: systemBlocks,
            tools,
            messages,
            ...(isFinalIteration ? { tool_choice: { type: 'none' } } : {}),
        });

        // Append the assistant turn verbatim so reasoning chain is
        // preserved across tool round-trips.
        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason !== 'tool_use') {
            const text = response.content
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text!)
                .join('')
                .trim();
            return { answerText: text, toolCalls, iterations, piWasReachable: piReachable };
        }

        // Dispatch each tool_use block; assemble matching tool_result blocks.
        const toolResults: ContentBlock[] = [];
        for (const block of response.content) {
            if (block.type !== 'tool_use' || !block.name) continue;
            toolCalls.push(block.name);
            const result = await dispatchTool(block.name, (block.input || {}) as Record<string, unknown>, piReachable);
            toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: result.content,
                is_error: result.isError,
            });
        }

        if (toolResults.length === 0) {
            // Only built-in tools fired (web_search runs server-side at
            // Anthropic — its tool_result is already inline in
            // response.content). Loop so the model can synthesise.
            continue;
        }

        messages.push({ role: 'user', content: toolResults });
    }

    // Should be unreachable now that the final iteration forces
    // tool_choice:'none'. Kept as a defensive fallback in case Haiku
    // somehow returns text+tool_use simultaneously on the forced
    // synthesis turn.
    return {
        answerText: 'I had trouble pulling the data together this turn — try rephrasing or ask again in a moment.',
        toolCalls,
        iterations,
        piWasReachable: piReachable,
    };
}
