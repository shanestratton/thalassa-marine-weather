// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { fetchWithTimeout, readJsonObject, readResponseTextLimited } from '../_shared/http-security.ts';

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
 *     responseMimeType?: string, // e.g. "application/json"
 *     imageBase64?: string,      // optional raw base64 image (no data URL prefix)
 *     imageMimeType?: string     // image/jpeg, image/png, or image/webp
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

    const caller = await requireAuthenticatedQuota(req, 'gemini', 30, 3600);
    if (caller instanceof Response) {
        return withCors(caller, CORS);
    }

    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) {
        console.error('[proxy-gemini] GEMINI_API_KEY is not configured');
        return corsResponse(JSON.stringify({ error: 'AI service is not configured' }), 503);
    }

    try {
        const body = await readJsonObject(req, 3_000_000);
        if (!body) return corsResponse(JSON.stringify({ error: 'Invalid request body' }), 400);
        const model = typeof body.model === 'string' ? body.model : 'gemini-2.5-flash';
        const prompt = body.prompt;
        const systemInstruction = body.systemInstruction;
        const temperature = body.temperature ?? 0.7;
        const maxTokens = body.maxTokens ?? 4096;
        const responseMimeType = body.responseMimeType;
        const imageBase64 = body.imageBase64;
        const imageMimeType = body.imageMimeType;

        if (!prompt || typeof prompt !== 'string' || prompt.length > 40_000) {
            return corsResponse(JSON.stringify({ error: 'prompt is required' }), 400);
        }
        const allowedModels = new Set(['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
        if (!allowedModels.has(model)) {
            return corsResponse(JSON.stringify({ error: 'Unsupported model' }), 400);
        }
        if (systemInstruction && (typeof systemInstruction !== 'string' || systemInstruction.length > 10_000)) {
            return corsResponse(JSON.stringify({ error: 'Invalid system instruction' }), 400);
        }
        const numericTemperature = Number(temperature);
        const numericMaxTokens = Number(maxTokens);
        const safeTemperature = Number.isFinite(numericTemperature)
            ? Math.min(2, Math.max(0, numericTemperature))
            : 0.7;
        const safeMaxTokens = Number.isFinite(numericMaxTokens)
            ? Math.min(4096, Math.max(1, Math.floor(numericMaxTokens)))
            : 1024;
        if (
            responseMimeType !== undefined &&
            (typeof responseMimeType !== 'string' || !['application/json', 'text/plain'].includes(responseMimeType))
        ) {
            return corsResponse(JSON.stringify({ error: 'Unsupported response type' }), 400);
        }
        const hasImage = imageBase64 !== undefined || imageMimeType !== undefined;
        if (hasImage) {
            const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
            const validBase64 =
                typeof imageBase64 === 'string' &&
                imageBase64.length > 0 &&
                imageBase64.length <= 2_800_000 &&
                imageBase64.length % 4 === 0 &&
                /^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64);
            if (!validBase64 || typeof imageMimeType !== 'string' || !allowedImageTypes.has(imageMimeType)) {
                return corsResponse(JSON.stringify({ error: 'Invalid image payload' }), 400);
            }
        }

        // Build the Gemini API request body
        const parts: Array<Record<string, unknown>> = [{ text: prompt }];
        if (hasImage) {
            parts.push({
                inlineData: {
                    mimeType: imageMimeType,
                    data: imageBase64,
                },
            });
        }
        const requestBody: Record<string, unknown> = {
            contents: [{ parts }],
            generationConfig: {
                temperature: safeTemperature,
                maxOutputTokens: safeMaxTokens,
            },
        };

        if (systemInstruction) {
            requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
        }

        if (responseMimeType) {
            (requestBody.generationConfig as Record<string, unknown>).responseMimeType = responseMimeType;
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

        const res = await fetchWithTimeout(
            url,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            },
            45_000,
        );

        const responseText = await readResponseTextLimited(res, 2_000_000);
        if (responseText === null) throw new Error('Gemini response exceeded the safety limit');
        const data = JSON.parse(responseText);

        if (res.status !== 200) {
            console.error(`[proxy-gemini] Gemini error: ${res.status}`, JSON.stringify(data).slice(0, 500));
            const safeStatus = res.status === 429 ? 429 : 502;
            return corsResponse(
                JSON.stringify({ error: res.status === 429 ? 'AI request quota exceeded' : 'AI request failed' }),
                safeStatus,
            );
        }

        // Extract the generated text from Gemini's response
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

        return corsResponse(JSON.stringify({ text, model, usage: data?.usageMetadata }), 200);
    } catch (e) {
        console.error('[proxy-gemini] Error:', e);
        return corsResponse(JSON.stringify({ error: 'Internal proxy error' }), 500);
    }
});
