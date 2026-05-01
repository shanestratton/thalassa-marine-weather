// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * proxy-bosun-fallback — Cloud fallback for Thalassa's voice console
 * when the on-boat Bosun Pi is unreachable.
 *
 * Pipeline:
 *   iOS records mic
 *   iOS does Web Speech STT on-device (no audio leaves the phone for STT)
 *   iOS POSTs { text } to this function
 *
 *   This function:
 *     1. Calls Anthropic claude-haiku-4-5 with a marine-aware system prompt
 *        and the same honesty principles Bosun-on-Pi enforces locally
 *     2. Calls ElevenLabs TTS with voice ID Wq15xSaY3gWvazBRaGEU (the same
 *        HAL clone Bosun uses on the boat — total continuity)
 *     3. Returns { answer_text, audio_b64, source: "cloud", timings_ms }
 *
 * Required Supabase Secrets:
 *   ANTHROPIC_API_KEY      Anthropic API key (Haiku 4.5 access)
 *   ELEVENLABS_API_KEY     ElevenLabs API key (Starter or Creator tier)
 *   ELEVENLABS_VOICE_ID    Voice ID — defaults to the HAL clone if unset
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const HAIKU_MODEL = 'claude-haiku-4-5';
const DEFAULT_VOICE_ID = 'Wq15xSaY3gWvazBRaGEU';

/**
 * Same honesty discipline Bosun-on-Pi runs locally — must extend to the
 * cloud fallback or the skipper gets inconsistent behaviour. Marine
 * context is unforgiving; "I don't know" is always a safe answer.
 */
const SYSTEM_PROMPT = `You are Bosun, AI first mate aboard "Serene Summer", a 55-foot Tayana yacht (skippered by Shane Stratton).

You are answering from cloud fallback because the boat's local AI brain is unreachable. You do NOT have access to the boat's live instruments, Cerbo GX, or vessel-specific knowledge corpus. Be honest about that.

VESSEL FACTS (static, always true):
- Vessel: Serene Summer, 55-foot Tayana
- Engine: Perkins 6.3544 marine diesel (6-cylinder, ~1991)
- Electrical: 12V DC house + 240V AC + Victron Cerbo GX + MultiPlus + MPPT solar + Enerdrive B-TEC lithium
- Monitoring: YachtSense Link

HONESTY RULES (these override everything):
1. You do NOT have live boat data right now. NEVER fabricate sensor readings, SOC, voltage, fuel level, GPS position, depth, wind, or any "current" boat state value.
2. If asked about live state, say plainly: "I'm answering from shore right now — I can't read the boat's instruments. Try the blue button to ask the on-boat Bosun for live readings."
3. The engine is a Perkins 6.3544. Never substitute Westerbeke, Yanmar, Volvo, or any other model.
4. For SAFETY-CRITICAL specs (torque, valve clearances, oil grades, fuel pressures, electrical voltages, anchor/rigging loads, medical doses): refuse to guess. Direct to the workshop manual or manufacturer.
5. For general marine questions, terminology, weather concepts: answer briefly and accurately. If you don't know, say so.

STYLE:
- Address as "Cap'n"
- One or two sentences typically. Calm, competent, brief.
- No fabrication to seem helpful — honesty > apparent helpfulness.`;

interface AskRequest {
    text: string;
    session_id?: string;
}

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string;
}

interface AnthropicResponse {
    content: Array<{ type: string; text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
}

async function callHaiku(userText: string): Promise<{ answer: string; ms: number }> {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const t0 = Date.now();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: HAIKU_MODEL,
            max_tokens: 400,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userText }] as AnthropicMessage[],
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Anthropic ${response.status}: ${body.slice(0, 200)}`);
    }

    const data: AnthropicResponse = await response.json();
    const text = data.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
    return { answer: text, ms: Date.now() - t0 };
}

async function callElevenLabs(text: string): Promise<{ audio_b64: string | null; ms: number }> {
    const apiKey = Deno.env.get('ELEVENLABS_API_KEY');
    if (!apiKey) {
        // Soft failure — we still return text-only if TTS isn't configured
        return { audio_b64: null, ms: 0 };
    }
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
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
                style: 0.0,
            },
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        console.error(`ElevenLabs ${response.status}: ${body.slice(0, 200)}`);
        return { audio_b64: null, ms: Date.now() - t0 };
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const audio_b64 = btoa(binary);
    return { audio_b64, ms: Date.now() - t0 };
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
        const { answer, ms: llmMs } = await callHaiku(text);
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
