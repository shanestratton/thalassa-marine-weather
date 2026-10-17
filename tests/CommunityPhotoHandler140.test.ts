import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import ts from 'typescript';
import jpeg from 'jpeg-js';
import { jsonResponse } from '../supabase/functions/_shared/http-security';
import { readPhotoBody, sanitizeReviewJpeg } from '../supabase/functions/community-review-photo/codec';
const uid = '10000000-0000-4000-8000-000000000001',
    id = '20000000-0000-4000-8000-000000000001',
    rev = '30000000-0000-4000-8000-000000000001';
const bytes = () => new Uint8Array(jpeg.encode({ width: 2, height: 2, data: new Uint8Array(16).fill(255) }, 78).data);
const digest = async (b: Uint8Array) =>
    Buffer.from(await webcrypto.subtle.digest('SHA-256', Uint8Array.from(b).buffer)).toString('hex');
const source = readFileSync(resolve('supabase/functions/community-review-photo/index.ts'), 'utf8').replace(
    /^import .*;\r?$/gm,
    '',
);
let handler: (r: Request) => Promise<Response>;
let access: {
    id: string;
    path: string;
    revision: string;
    review_revision: string;
    status: string;
    bytes: number;
    digest: string;
};
let auth: ReturnType<typeof vi.fn>,
    rpc: ReturnType<typeof vi.fn>,
    upload: ReturnType<typeof vi.fn>,
    download: ReturnType<typeof vi.fn>,
    remove: ReturnType<typeof vi.fn>;
beforeEach(async () => {
    const data = bytes();
    access = {
        id,
        path: uid + '/' + id + '.jpg',
        revision: rev,
        review_revision: rev,
        status: 'approved',
        bytes: data.length,
        digest: await digest(data),
    };
    auth = vi.fn().mockResolvedValue({ userId: uid });
    rpc = vi
        .fn()
        .mockImplementation(async (_fn: string, args: { p_action: string; p_input: Record<string, unknown> }) => ({
            data: args.p_action === 'finish' ? { ...access, status: 'pending' } : access,
            error: null,
        }));
    upload = vi.fn().mockResolvedValue({ error: null });
    download = vi.fn().mockResolvedValue({ data: new NodeBlob([data], { type: 'image/jpeg' }), error: null });
    remove = vi.fn().mockResolvedValue({ error: null });
    runInNewContext(
        ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } })
            .outputText,
        {
            Deno: {
                serve: (h: typeof handler) => {
                    handler = h;
                },
                env: { get: (k: string) => (k === 'SUPABASE_URL' ? 'https://fixture.invalid' : 'fixture-service') },
            },
            createClient: () => ({ rpc, storage: { from: () => ({ upload, download, remove }) } }),
            requireAuthenticatedQuota: auth,
            withCors: (r: Response, headers: Record<string, string>) =>
                new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), ...headers } }),
            jsonResponse,
            readPhotoBody,
            sanitizeReviewJpeg,
            jpeg,
            Response,
            Request,
            URL,
            Uint8Array,
            crypto: webcrypto,
        },
    );
});
describe('actual photo Edge handler with fake auth/DB/Storage boundary', () => {
    it('authenticates and applies bounded quota before any image access', async () => {
        auth.mockResolvedValue(new Response('denied', { status: 401 }));
        expect((await handler(new Request('https://fixture.invalid?id=' + id))).status).toBe(401);
        expect(rpc).not.toHaveBeenCalled();
        expect(download).not.toHaveBeenCalled();
        expect(auth.mock.calls[0].slice(1)).toEqual(['community-photo-read', 120, 3600]);
    });
    it('serves exact approved bytes with no cache only after two current DB checks', async () => {
        const response = await handler(new Request('https://fixture.invalid?id=' + id));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(response.headers.get('content-type')).toBe('image/jpeg');
        expect(rpc.mock.calls.map((x) => x[1].p_action)).toEqual(['access', 'access']);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes());
    });
    it('withholds bytes if report/delete retires permission while Storage awaits', async () => {
        download.mockImplementation(async () => {
            rpc.mockResolvedValue({ data: null, error: { message: 'Photo unavailable' } });
            return { data: new NodeBlob([bytes()]), error: null };
        });
        const response = await handler(new Request('https://fixture.invalid?id=' + id));
        expect(response.status).toBe(409);
        expect(response.headers.get('content-type')).toContain('json');
    });
    it('refuses changed hash or current revision after download', async () => {
        access.digest = '0'.repeat(64);
        expect((await handler(new Request('https://fixture.invalid?id=' + id))).status).toBe(409);
        access.digest = await digest(bytes());
        let count = 0;
        rpc.mockImplementation(async () => ({
            data: ++count === 1 ? access : { ...access, revision: id },
            error: null,
        }));
        expect((await handler(new Request('https://fixture.invalid?id=' + id))).status).toBe(409);
    });
    it('stores sanitized pixels only and never self-approves', async () => {
        const decoded = jpeg.decode(bytes(), { useTArray: true });
        const dirty = jpeg.encode(
            { ...decoded, comments: ['GPS metadata private'] } as Parameters<typeof jpeg.encode>[0],
            80,
        ).data;
        const response = await handler(
            new Request('https://fixture.invalid', {
                method: 'POST',
                headers: { 'content-type': 'image/jpeg', 'x-review-id': id, 'x-review-revision': rev },
                body: Uint8Array.from(dirty).buffer,
            }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id, status: 'pending' });
        expect(new TextDecoder().decode(upload.mock.calls[0][1])).not.toContain('GPS');
        expect(rpc.mock.calls.map((x) => x[1].p_action)).toEqual(['reserve', 'finish']);
        expect(upload.mock.calls[0][2]).toMatchObject({ upsert: false, contentType: 'image/jpeg', cacheControl: '0' });
    });
    it('removes an uploaded object if late finalization loses its current review', async () => {
        rpc.mockImplementation(async (_fn: string, args: { p_action: string }) =>
            args.p_action === 'finish' ? { data: null, error: { message: 'retired' } } : { data: access, error: null },
        );
        const response = await handler(
            new Request('https://fixture.invalid', {
                method: 'POST',
                headers: { 'content-type': 'image/jpeg', 'x-review-id': id, 'x-review-revision': rev },
                body: Uint8Array.from(bytes()).buffer,
            }),
        );
        expect(response.status).toBe(409);
        expect(remove).toHaveBeenCalledWith([access.path]);
    });
    it('rejects a foreign path before upload and non-JPEG before reservation', async () => {
        access.path = 'other/' + id + '.jpg';
        const req = () =>
            new Request('https://fixture.invalid', {
                method: 'POST',
                headers: { 'content-type': 'image/jpeg', 'x-review-id': id, 'x-review-revision': rev },
                body: Uint8Array.from(bytes()).buffer,
            });
        expect((await handler(req())).status).toBe(409);
        expect(upload).not.toHaveBeenCalled();
        rpc.mockClear();
        const r = new Request('https://fixture.invalid', {
            method: 'POST',
            headers: { 'content-type': 'image/png', 'x-review-id': id, 'x-review-revision': rev },
            body: 'png',
        });
        expect((await handler(r)).status).toBe(400);
        expect(rpc).not.toHaveBeenCalled();
    });
});
