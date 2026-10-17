import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.9';
import jpeg from 'npm:jpeg-js@0.4.4';
import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse } from '../_shared/http-security.ts';
import { type JpegCodec, readPhotoBody, sanitizeReviewJpeg } from './codec.ts';
const BUCKET = 'community-review-photos';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const origins = new Set([
    'capacitor://localhost',
    'http://localhost',
    'https://localhost',
    'https://thalassawx.app',
    'https://www.thalassawx.app',
]);
Deno.serve(async (req: Request) => {
    const origin = req.headers.get('origin');
    const cors = {
        'Access-Control-Allow-Origin': origin && origins.has(origin) ? origin : 'null',
        'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-review-id,x-review-revision',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Vary': 'Origin',
    };
    const response = (body: unknown, status = 200) => withCors(jsonResponse(body, status), cors);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!['GET', 'POST'].includes(req.method)) return response({ error: 'Method unavailable' }, 405);
    try {
        const caller = await requireAuthenticatedQuota(
            req,
            req.method === 'GET' ? 'community-photo-read' : 'community-photo-upload',
            req.method === 'GET' ? 120 : 10,
            3600,
        );
        if (caller instanceof Response) return withCors(caller, cors);
        const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
            auth: { persistSession: false },
        });
        const rpc = async (action: string, input: Record<string, unknown>) => {
            const { data, error } = await client.rpc('community_review_photo', {
                p_action: action,
                p_user: caller.userId,
                p_input: input,
            });
            if (
                error || !data || typeof data.path !== 'string' ||
                !data.path.startsWith(caller.userId + '/') && action !== 'access'
            ) throw new Error('Photo unavailable');
            return data as {
                id: string;
                path: string;
                revision: string;
                review_revision: string;
                status: string;
                bytes: number;
                digest: string;
            };
        };
        if (req.method === 'GET') {
            const id = new URL(req.url).searchParams.get('id');
            if (!id || !uuid.test(id)) return response({ error: 'Photo unavailable' }, 404);
            const before = await rpc('access', { id });
            const { data, error } = await client.storage.from(BUCKET).download(before.path);
            if (error || !data || data.size !== before.bytes || data.size > 1_048_576) {
                throw new Error('Photo unavailable');
            }
            const bytes = new Uint8Array(await data.arrayBuffer());
            const digest = Array.from(
                new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)),
            ).map((x) => x.toString(16).padStart(2, '0')).join('');
            const after = await rpc('access', { id });
            if (JSON.stringify(before) !== JSON.stringify(after) || digest !== before.digest) {
                throw new Error('Photo changed');
            }
            return new Response(bytes, {
                headers: {
                    ...cors,
                    'Content-Type': 'image/jpeg',
                    'Cache-Control': 'private, no-store, max-age=0',
                    'X-Content-Type-Options': 'nosniff',
                },
            });
        }
        const review_id = req.headers.get('x-review-id'), revision = req.headers.get('x-review-revision');
        if (
            req.headers.get('content-type')?.split(';')[0] !== 'image/jpeg' || !review_id || !uuid.test(review_id) ||
            !revision || !uuid.test(revision)
        ) return response({ error: 'Saved review and JPEG required' }, 400);
        const bytes = sanitizeReviewJpeg(await readPhotoBody(req), jpeg as unknown as JpegCodec);
        const reserved = await rpc('reserve', { review_id, revision });
        try {
            const { error } = await client.storage.from(BUCKET).upload(reserved.path, bytes, {
                contentType: 'image/jpeg',
                upsert: false,
                cacheControl: '0',
            });
            if (error) throw new Error('Photo upload failed');
            const digest = Array.from(
                new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)),
            ).map((x) => x.toString(16).padStart(2, '0')).join('');
            await rpc('finish', { id: reserved.id, bytes: bytes.length, digest });
            return response({ id: reserved.id, status: 'pending' });
        } catch (error) {
            await client.storage.from(BUCKET).remove([reserved.path]).catch(() => {});
            throw error;
        }
    } catch {
        return response({
            error: 'Photo unavailable. Reload the review and try again; your photo remains private until approved.',
        }, 409);
    }
});
