// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

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

function prepareForTTS(text: string): string {
    return text.replace(/\bSerene Summer\b/g, 'Serene-Summer');
}

interface AskBody {
    text?: string;
    voice_id?: string;
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

    const apiKey = Deno.env.get('ELEVENLABS_API_KEY');
    if (!apiKey) {
        return new Response(JSON.stringify({ error: 'ELEVENLABS_API_KEY not configured' }), {
            status: 500,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    let body: AskBody;
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
        return new Response(JSON.stringify({ error: 'missing text' }), {
            status: 400,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    const voiceId = body.voice_id || Deno.env.get('ELEVENLABS_VOICE_ID') || DEFAULT_VOICE_ID;

    const t0 = Date.now();
    const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
            Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
            text: prepareForTTS(text),
            model_id: 'eleven_flash_v2_5',
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, speed: 1.1 },
        }),
    });

    if (!upstream.ok) {
        const errBody = await upstream.text();
        console.error(`[elevenlabs-tts] ${upstream.status}: ${errBody.slice(0, 300)}`);
        return new Response(JSON.stringify({ error: `ElevenLabs ${upstream.status}` }), {
            status: 502,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    const arrayBuffer = await upstream.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    const audio_b64 = btoa(binary);

    return new Response(JSON.stringify({ audio_b64, ms: Date.now() - t0 }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
    });
});
