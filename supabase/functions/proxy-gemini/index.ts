// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * proxy-gemini — Google Gemini API Proxy
 *
 * Proxies Gemini generative AI requests through Supabase Edge so the API key
 * never leaves the server. The client sends the model, prompt, and config;
 * this function forwards to the Gemini API with the secret key.
 *
 * Request: POST with JSON body:
 *   {
 *     model?: string,       // default: "gemini-2.5-flash"
 *     prompt: string,       // the text prompt
 *     systemInstruction?: string,
 *     temperature?: number, // default: 0.7
 *     maxTokens?: number,   // default: 8192
 *     responseMimeType?: string // e.g. "application/json"
 *   }
 *
 * Required Supabase Secret:
 *   GEMINI_API_KEY
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });
}

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== 'POST') {
        return corsResponse(JSON.stringify({ error: 'POST required' }), 405);
    }

    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) {
        return corsResponse(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), 500);
    }

    try {
        const {
            model = 'gemini-2.5-flash',
            prompt,
            systemInstruction,
            temperature = 0.7,
            maxTokens = 8192,
            responseMimeType,
        } = await req.json();

        if (!prompt || typeof prompt !== 'string') {
            return corsResponse(JSON.stringify({ error: 'prompt is required' }), 400);
        }

        // Build the Gemini API request body
        const requestBody: Record<string, unknown> = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature,
                maxOutputTokens: maxTokens,
            },
        };

        if (systemInstruction) {
            requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
        }

        if (responseMimeType) {
            (requestBody.generationConfig as Record<string, unknown>).responseMimeType = responseMimeType;
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        const data = await res.json();

        if (res.status !== 200) {
            console.error(`[proxy-gemini] Gemini error: ${res.status}`, JSON.stringify(data).slice(0, 500));
            return corsResponse(JSON.stringify({ error: data.error?.message || `HTTP ${res.status}` }), res.status);
        }

        // Extract the generated text from Gemini's response
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

        return corsResponse(JSON.stringify({ text, model, usage: data?.usageMetadata }), 200);
    } catch (e) {
        console.error('[proxy-gemini] Error:', e);
        return corsResponse(JSON.stringify({ error: 'Internal proxy error' }), 500);
    }
});
