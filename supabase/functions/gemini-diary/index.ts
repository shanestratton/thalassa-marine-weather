// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

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
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

function jsonResponse(data: unknown, status = 200) {
    return corsResponse(JSON.stringify(data), status, { "Content-Type": "application/json" });
}

// ── Gemini API ────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-2.0-flash";

async function callGemini(apiKey: string, contents: unknown[], systemInstruction?: string) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) {
        body.systemInstruction = {
            parts: [{ text: systemInstruction }],
        };
    }

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const err = await res.text().catch(() => "");
        console.error(`[gemini-diary] Gemini API error ${res.status}: ${err}`);
        throw new Error(`Gemini API error: ${res.status}`);
    }

    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

// ── Action: Enhance ───────────────────────────────────────────

async function handleEnhance(apiKey: string, body: {
    text: string;
    mood: string;
    location?: string;
    weather?: string;
}) {
    const { text, mood, location, weather } = body;
    if (!text || text.trim().length < 5) {
        return jsonResponse({ error: "Text too short to enhance" }, 400);
    }

    const systemPrompt = `You are a skilled maritime journal editor helping a captain polish their diary entries.

RULES:
- Preserve the original meaning and voice completely
- Enhance the prose with vivid nautical language where appropriate
- Fix grammar, spelling, and punctuation
- Keep the same approximate length (do not double it)
- Do NOT add fictional events or details
- Do NOT add markdown, headers, or formatting
- Return ONLY the polished text, nothing else

CONTEXT:
- Mood: ${mood}
${location ? `- Location: ${location}` : ""}
${weather ? `- Weather: ${weather}` : ""}`;

    const enhanced = await callGemini(
        apiKey,
        [{ role: "user", parts: [{ text: `Polish this journal entry:\n\n${text}` }] }],
        systemPrompt,
    );

    if (!enhanced) {
        return jsonResponse({ error: "Gemini returned empty response" }, 500);
    }

    return jsonResponse({ enhanced });
}

// ── Action: Transcribe ────────────────────────────────────────

async function handleTranscribe(apiKey: string, body: {
    audio_base64: string;
    mime_type: string;
}) {
    const { audio_base64, mime_type } = body;
    if (!audio_base64) {
        return jsonResponse({ error: "No audio data provided" }, 400);
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
        [{
            role: "user",
            parts: [
                {
                    inlineData: {
                        mimeType: mime_type || "audio/webm",
                        data: audio_base64,
                    },
                },
                { text: "Transcribe this audio recording from a ship captain's voice diary." },
            ],
        }],
        systemPrompt,
    );

    return jsonResponse({ transcript: transcript || "" });
}

// ── Main Handler ──────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return corsResponse(null, 204);
    }

    if (req.method !== "POST") {
        return jsonResponse({ error: "POST required" }, 405);
    }

    try {
        const apiKey = Deno.env.get("GEMINI_API_KEY");
        if (!apiKey) {
            console.error("[gemini-diary] GEMINI_API_KEY not set");
            return jsonResponse({ error: "Gemini not configured" }, 500);
        }

        const body = await req.json();
        const { action } = body;

        console.log(`[gemini-diary] Action: ${action}`);

        switch (action) {
            case "enhance":
                return await handleEnhance(apiKey, body);
            case "transcribe":
                return await handleTranscribe(apiKey, body);
            default:
                return jsonResponse({ error: `Unknown action: ${action}` }, 400);
        }
    } catch (err) {
        console.error("[gemini-diary] Error:", err);
        return jsonResponse({ error: String(err) }, 500);
    }
});
