// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { fetchWithTimeout, readJsonObject, readResponseTextLimited } from '../_shared/http-security.ts';

/**
 * gemini-diary — Captain's Journal AI Assistant
 *
 * Two actions:
 *   1. "enhance"    — Polishes journal text with nautical flair
 *   2. "transcribe" — Converts base64 audio to text via Gemini
 *
 * Request: POST with JSON body:
 *   { action: "enhance", text: string, mood: string, location?: string, weather?: string }
 *   { action: "transcribe", audio_base64: string, mime_type: string }
 *
 * Required Supabase Secret:
 *   GEMINI_API_KEY — Google AI API key
 */

// ── CORS ──────────────────────────────────────────────────────

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

function jsonResponse(data: unknown, status = 200) {
    return corsResponse(JSON.stringify(data), status, { 'Content-Type': 'application/json' });
}

// ── Gemini API ────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.0-flash';

async function callGemini(apiKey: string, contents: unknown[], systemInstruction?: string) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) {
        body.systemInstruction = {
            parts: [{ text: systemInstruction }],
        };
    }

    const res = await fetchWithTimeout(
        url,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
        45_000,
    );

    const responseText = await readResponseTextLimited(res, 2_000_000);
    if (responseText === null) throw new Error('Gemini response exceeded the safety limit');
    if (!res.ok) {
        console.error(`[gemini-diary] Gemini API error ${res.status}: ${responseText.slice(0, 500)}`);
        throw new Error(`Gemini API error: ${res.status}`);
    }

    const data = JSON.parse(responseText);
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

// ── Action: Enhance ───────────────────────────────────────────

async function handleEnhance(
    apiKey: string,
    body: {
        text: string;
        mood: string;
        location?: string;
        weather?: string;
    },
) {
    const { text, mood, location, weather } = body;
    if (
        !text ||
        text.trim().length < 5 ||
        text.length > 20_000 ||
        mood.length > 80 ||
        (location?.length ?? 0) > 200 ||
        (weather?.length ?? 0) > 500
    ) {
        return jsonResponse({ error: 'Text too short to enhance' }, 400);
    }

    const systemPrompt = `You are a romantic maritime journal editor with the soul of Patrick O'Brian and the wanderlust of Joshua Slocum. You are polishing a sailor's diary — their personal record of an extraordinary voyage.

RULES:
- Preserve the original meaning and every factual detail completely
- Elevate the prose into something lyrical, vivid, and deeply romantic — make the reader ache to be there
- Use rich sensory language: the taste of salt spray, the weight of the tiller, the way light fractures across the swell
- Even hardship should sound magnificent — seasickness becomes a communion with the ocean's raw power, a storm becomes a breathtaking dance with the elements, exhaustion becomes the sweet price of freedom
- Make every moment feel like something worth crossing oceans for
- Fix grammar, spelling, and punctuation
- Keep approximately the same length (do not double it)
- Do NOT add fictional events, people, or details that weren't mentioned
- Do NOT add markdown, headers, or formatting
- Return ONLY the polished text, nothing else

TONE: Romantic, evocative, visceral. The reader should finish and think "I need to be on that boat."

CONTEXT:
- Mood: ${mood}
${location ? `- Location: ${location}` : ''}
${weather ? `- Weather: ${weather}` : ''}`;

    const enhanced = await callGemini(
        apiKey,
        [{ role: 'user', parts: [{ text: `Polish this journal entry:\n\n${text}` }] }],
        systemPrompt,
    );

    if (!enhanced) {
        return jsonResponse({ error: 'Gemini returned empty response' }, 500);
    }

    return jsonResponse({ enhanced });
}

// ── Action: Transcribe ────────────────────────────────────────

async function handleTranscribe(
    apiKey: string,
    body: {
        audio_base64: string;
        mime_type: string;
    },
) {
    const { audio_base64, mime_type } = body;
    const allowedMimeTypes = new Set(['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg']);
    if (
        !audio_base64 ||
        audio_base64.length > 10_000_000 ||
        audio_base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(audio_base64) ||
        !allowedMimeTypes.has(mime_type)
    ) {
        return jsonResponse({ error: 'Invalid audio data' }, 400);
    }

    const systemPrompt = `You are a speech-to-text transcription engine for a maritime captain's voice diary.

RULES:
- Transcribe the audio accurately and completely
- Fix obvious speech errors and filler words (um, uh, like)
- Use proper punctuation and sentence structure
- Preserve nautical terminology exactly as spoken
- Return ONLY the transcribed text, nothing else
- If the audio is unclear or empty, return an empty string`;

    const transcript = await callGemini(
        apiKey,
        [
            {
                role: 'user',
                parts: [
                    {
                        inlineData: {
                            mimeType: mime_type || 'audio/webm',
                            data: audio_base64,
                        },
                    },
                    { text: "Transcribe this audio recording from a ship captain's voice diary." },
                ],
            },
        ],
        systemPrompt,
    );

    return jsonResponse({ transcript: transcript || '' });
}

// ── Main Handler ──────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return corsResponse(null, 204);
    }

    if (req.method !== 'POST') {
        return jsonResponse({ error: 'POST required' }, 405);
    }

    const caller = await requireAuthenticatedQuota(req, 'gemini_diary', 30, 3600);
    if (caller instanceof Response) {
        return withCors(caller, CORS);
    }

    try {
        const apiKey = Deno.env.get('GEMINI_API_KEY');
        if (!apiKey) {
            console.error('[gemini-diary] GEMINI_API_KEY not set');
            return jsonResponse({ error: 'Gemini not configured' }, 500);
        }

        const body = await readJsonObject(req, 10_100_000);
        if (!body) return jsonResponse({ error: 'Invalid request body' }, 400);
        const { action } = body;

        if (
            action === 'enhance' &&
            (typeof body.text !== 'string' ||
                body.text.length > 20_000 ||
                typeof body.mood !== 'string' ||
                body.mood.length > 80 ||
                (body.location !== undefined && (typeof body.location !== 'string' || body.location.length > 200)) ||
                (body.weather !== undefined && (typeof body.weather !== 'string' || body.weather.length > 500)))
        ) {
            return jsonResponse({ error: 'Invalid journal request' }, 400);
        }
        if (
            action === 'transcribe' &&
            (typeof body.audio_base64 !== 'string' ||
                body.audio_base64.length > 10_000_000 ||
                typeof body.mime_type !== 'string')
        ) {
            return jsonResponse({ error: 'Invalid or oversized audio' }, 400);
        }

        console.info(`[gemini-diary] Action: ${action}`);

        switch (action) {
            case 'enhance':
                return await handleEnhance(
                    apiKey,
                    body as {
                        text: string;
                        mood: string;
                        location?: string;
                        weather?: string;
                    },
                );
            case 'transcribe':
                return await handleTranscribe(
                    apiKey,
                    body as {
                        audio_base64: string;
                        mime_type: string;
                    },
                );
            default:
                return jsonResponse({ error: 'Unknown action' }, 400);
        }
    } catch (err) {
        console.error('[gemini-diary] Error:', err);
        return jsonResponse({ error: 'Diary assistant is temporarily unavailable' }, 502);
    }
});
