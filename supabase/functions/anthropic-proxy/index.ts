// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { readResponseTextLimited } from '../_shared/http-security.ts';

/**
 * anthropic-proxy — thin pass-through to api.anthropic.com/v1/messages.
 *
 * Why this exists: the iOS orchestrator (services/voice/orchestrator.ts)
 * runs the tool-use loop on-device so it can dispatch Pi-local tools
 * without round-tripping through Supabase. But we don't want
 * ANTHROPIC_API_KEY shipping in the iOS bundle. So this function holds
 * the key server-side and forwards verbatim — no system-prompt assembly,
 * no tool injection, no caching tweaks. The body the client sends IS
 * the body Anthropic receives, with `x-api-key` and `anthropic-version`
 * headers added.
 *
 * Companion endpoint: elevenlabs-tts (TTS forwarder).
 *
 * Required Supabase secret:
 *   ANTHROPIC_API_KEY
 *
 * Diagnostics: each call writes a [token-cost] line to function logs
 * with input/output/cache_create/cache_read counts. Same shape as the
 * legacy proxy-bosun-fallback so existing dashboards keep working.
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
/**
 * 90s ceiling on the upstream call. Tool-use loops on the client may
 * make multiple round trips, but each individual /v1/messages call
 * shouldn't take this long; if it does, something is wrong upstream.
 */
const ANTHROPIC_TIMEOUT_MS = 90_000;

interface AnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

function logTokenCost(usage: AnthropicUsage | undefined, ms: number): void {
    if (!usage) return;
    const inTok = usage.input_tokens ?? 0;
    const outTok = usage.output_tokens ?? 0;
    const cacheCreate = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    // Pricing reference (Haiku 4.5, May 2026):
    //   input        $1 / M tokens
    //   output       $5 / M tokens
    //   cache write  $1.25 / M tokens
    //   cache read   $0.10 / M tokens
    const usd =
        (inTok / 1_000_000) * 1 +
        (outTok / 1_000_000) * 5 +
        (cacheCreate / 1_000_000) * 1.25 +
        (cacheRead / 1_000_000) * 0.1;
    console.log(
        `[token-cost] outcome=passthrough in=${inTok} out=${outTok} ` +
            `cache_create=${cacheCreate} cache_read=${cacheRead} ms=${ms} usd≈${usd.toFixed(5)}`,
    );
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

    const caller = await requireAuthenticatedQuota(req, 'anthropic', 60, 3600);
    if (caller instanceof Response) {
        return withCors(caller, CORS);
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
        console.error('[anthropic-proxy] ANTHROPIC_API_KEY is not configured');
        return new Response(JSON.stringify({ error: 'AI service is not configured' }), {
            status: 503,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    // Read the body verbatim — we don't parse or modify the Anthropic
    // request shape. The client owns it.
    const bodyText = await req.text();
    if (!bodyText || new TextEncoder().encode(bodyText).byteLength > 250_000) {
        return new Response(JSON.stringify({ error: 'empty body' }), {
            status: 400,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }
    try {
        const parsed = JSON.parse(bodyText) as { model?: string; max_tokens?: number };
        if (!['claude-haiku-4-5', 'claude-sonnet-4-5'].includes(parsed.model || '')) {
            return new Response(JSON.stringify({ error: 'unsupported model' }), {
                status: 400,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }
        if (
            !Number.isInteger(parsed.max_tokens) ||
            (parsed.max_tokens as number) < 1 ||
            (parsed.max_tokens as number) > 4096
        ) {
            return new Response(JSON.stringify({ error: 'invalid max_tokens' }), {
                status: 400,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }
    } catch {
        return new Response(JSON.stringify({ error: 'invalid JSON' }), {
            status: 400,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);
    const t0 = Date.now();

    let upstream: Response;
    try {
        upstream = await fetch(ANTHROPIC_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_VERSION,
            },
            body: bodyText,
            signal: ctrl.signal,
        });
    } catch (err) {
        clearTimeout(watchdog);
        const e = err as Error;
        const message = e.name === 'AbortError' ? 'Anthropic request timed out' : 'Anthropic upstream request failed';
        console.error('[anthropic-proxy]', message);
        return new Response(JSON.stringify({ error: message }), {
            status: 502,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    } finally {
        clearTimeout(watchdog);
    }

    const responseText = await readResponseTextLimited(upstream, 2_000_000);
    if (responseText === null) {
        console.error('[anthropic-proxy] Upstream response exceeded the byte limit');
        return new Response(JSON.stringify({ error: 'AI response exceeded the safety limit' }), {
            status: 502,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }
    const ms = Date.now() - t0;

    // Parse just enough to log usage. Don't fail the call if parsing
    // fails — pass the raw response back regardless.
    if (upstream.ok) {
        try {
            const parsed = JSON.parse(responseText) as { usage?: AnthropicUsage };
            logTokenCost(parsed.usage, ms);
        } catch {
            /* non-JSON response from Anthropic is exceptional — don't block on it */
        }
    } else {
        console.error(`[anthropic-proxy] upstream ${upstream.status}: ${responseText.slice(0, 300)}`);
    }

    return new Response(responseText, {
        status: upstream.status,
        headers: {
            ...CORS,
            'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        },
    });
});
