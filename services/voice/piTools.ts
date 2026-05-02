/**
 * piTools — dispatch Haiku tool_use blocks against the Pi-side
 * `/tool/*` endpoints documented in docs/BOSUN_TOOL_API.md.
 *
 * The orchestrator (services/voice/orchestrator.ts) calls
 * `executePiTool(name, input)` whenever Haiku returns a tool_use that
 * targets a Pi-local tool. This module owns the HTTP shape and the
 * envelope unwrapping; orchestrator stays agnostic to where a tool
 * actually runs.
 *
 * Pi envelope (from BOSUN_TOOL_API.md §"Common envelope"):
 *
 *   { value, source, timestamp, error, latency_ms }
 *
 * - 200 + value=null + error="reason" → capability unavailable but Pi
 *   is healthy (data-not-failure). We pass this through as a
 *   tool_result so Haiku can narrate "I tried to read fuel state but
 *   the Pi says: <reason>".
 * - 4xx → caller error (bad JSON / missing required field). Surface as
 *   tool_result with is_error=true so Haiku doesn't retry forever.
 * - 5xx → Pi broken. Surface as is_error=true; orchestrator may decide
 *   to mark Pi unreachable for the rest of the cycle.
 */

import { BoatNetworkService } from '../BoatNetworkService';

const BOSUN_WEB_PORT = 5000;

/** Per-tool latency budget × 1.5 (per BOSUN_TOOL_API.md §latency budgets). */
const TOOL_TIMEOUT_MS: Record<string, number> = {
    get_vessel_position: 75,
    get_vessel_state: 150,
    get_vessel_profile: 75,
    search_manuals: 450,
    query_logs: 450,
};
const DEFAULT_TIMEOUT_MS = 1500;

/** Pi tool names the orchestrator can dispatch via this module. */
export const PI_TOOL_NAMES = [
    'get_vessel_position',
    'get_vessel_state',
    'get_vessel_profile',
    'search_manuals',
    'query_logs',
] as const;

export type PiToolName = (typeof PI_TOOL_NAMES)[number];

export function isPiToolName(name: string): name is PiToolName {
    return (PI_TOOL_NAMES as readonly string[]).includes(name);
}

export interface PiEnvelope {
    value: unknown;
    source: string;
    timestamp: string;
    error: string | null;
    latency_ms: number;
}

/**
 * Result the orchestrator hands back to Haiku as a tool_result block.
 * `content` is JSON-stringified so Haiku sees structured data; the
 * `is_error` flag tells Anthropic this attempt failed (without making
 * the model itself decide).
 */
export interface PiToolResult {
    content: string;
    is_error: boolean;
}

function getBosunBase(): string | null {
    const piHost = BoatNetworkService.getState().piHost;
    if (!piHost) return null;
    return `http://${piHost}:${BOSUN_WEB_PORT}`;
}

/**
 * Quick reachability ping. Used by the orchestrator to decide whether
 * to register Pi tools with Haiku at all (no point telling Haiku it
 * can search manuals if the Pi isn't on the LAN).
 */
export async function isBosunWebReachable(): Promise<boolean> {
    const base = getBosunBase();
    if (!base) return false;
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), 1500);
    try {
        const r = await fetch(`${base}/api/health`, { signal: ctrl.signal });
        if (!r.ok) return false;
        const data = (await r.json()) as { ok?: boolean; service?: string };
        return data.ok === true && data.service === 'bosun-web';
    } catch {
        return false;
    } finally {
        clearTimeout(watchdog);
    }
}

/**
 * Dispatch a single Haiku tool_use against the Pi. Returns a
 * PiToolResult ready to be shipped back to Anthropic as a tool_result
 * block. Never throws — converts every failure mode into a structured
 * is_error result so the orchestrator's tool loop stays simple.
 */
export async function executePiTool(name: PiToolName, input: Record<string, unknown>): Promise<PiToolResult> {
    const base = getBosunBase();
    if (!base) {
        return {
            content: JSON.stringify({
                error: "Pi not on the network. Can't read live boat data right now.",
            }),
            is_error: true,
        };
    }

    const url = `${base}/tool/${name}`;
    const timeout = TOOL_TIMEOUT_MS[name] ?? DEFAULT_TIMEOUT_MS;
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), timeout);

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input || {}),
            signal: ctrl.signal,
        });
    } catch (err) {
        const e = err as Error;
        const message =
            e.name === 'AbortError'
                ? `Pi tool '${name}' timed out (>${timeout}ms)`
                : `Pi tool '${name}' transport error: ${e.message}`;
        return { content: JSON.stringify({ error: message }), is_error: true };
    } finally {
        clearTimeout(watchdog);
    }

    let parsed: PiEnvelope | null = null;
    let rawText = '';
    try {
        rawText = await response.text();
        parsed = rawText ? (JSON.parse(rawText) as PiEnvelope) : null;
    } catch {
        // Non-JSON response is exceptional — surface as is_error.
        return {
            content: JSON.stringify({
                error: `Pi tool '${name}' returned non-JSON: ${rawText.slice(0, 200)}`,
            }),
            is_error: true,
        };
    }

    if (response.status >= 500) {
        return {
            content: JSON.stringify({
                error: `Pi tool '${name}' failed: HTTP ${response.status}${parsed?.error ? ` — ${parsed.error}` : ''}`,
            }),
            is_error: true,
        };
    }
    if (response.status >= 400) {
        return {
            content: JSON.stringify({
                error: `Pi tool '${name}' rejected input: HTTP ${response.status}${parsed?.error ? ` — ${parsed.error}` : ''}`,
            }),
            is_error: true,
        };
    }

    // 200 with value=null + error: capability unavailable, but Pi is
    // healthy. Pass to Haiku as a non-error tool_result so it can
    // narrate "I tried to read X but: <reason>" honestly. The narrative
    // is more honest than swallowing the error and pretending we
    // couldn't see anything at all.
    if (parsed && parsed.value === null && parsed.error) {
        return {
            content: JSON.stringify({
                value: null,
                source: parsed.source,
                timestamp: parsed.timestamp,
                error: parsed.error,
            }),
            is_error: false,
        };
    }

    // Normal success — pass the envelope through.
    return {
        content: JSON.stringify(parsed),
        is_error: false,
    };
}
