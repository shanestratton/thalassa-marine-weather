import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mockGetAuthenticatedFunctionHeaders = vi.fn();
const { mockGetUser } = vi.hoisted(() => ({
    mockGetUser: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: mockGetUser,
        },
    },
    supabaseUrl: 'https://example.supabase.co',
}));

vi.mock('../services/supabaseAuth', () => ({
    getAuthenticatedFunctionHeaders: () => mockGetAuthenticatedFunctionHeaders(),
}));

import { moderatePhoto } from '../services/ProfilePhotoService';

const photoBlob = (bytes: number[] = [1, 2, 3], type = 'image/jpeg'): Blob =>
    ({
        size: bytes.length,
        type,
        arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from(bytes).buffer),
    }) as unknown as Blob;

const mockResponse = (status: number, payload: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        json: vi.fn().mockResolvedValue(payload),
    }) as unknown as Response;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('moderatePhoto', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mockGetAuthenticatedFunctionHeaders.mockReset();
        mockGetAuthenticatedFunctionHeaders.mockResolvedValue({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
            apikey: 'test-anon-key',
        });
        setAuthIdentityScope('test-user');
        mockGetUser.mockReset();
        mockGetUser.mockResolvedValue({
            data: { user: { id: 'test-user' } },
            error: null,
        });
    });

    it('sends authenticated inline image data and accepts a valid approval', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(mockResponse(200, { text: '{"verdict":"approved","reason":"Suitable profile photo"}' }));

        await expect(moderatePhoto(photoBlob())).resolves.toEqual({
            verdict: 'approved',
            reason: 'Suitable profile photo',
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'https://example.supabase.co/functions/v1/proxy-gemini',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
            }),
        );
        const request = fetchMock.mock.calls[0][1] as RequestInit;
        const body = JSON.parse(String(request.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
            model: 'gemini-2.5-flash',
            imageBase64: 'AQID',
            imageMimeType: 'image/jpeg',
            responseMimeType: 'application/json',
            temperature: 0,
        });
        expect(String(body.systemInstruction)).toContain('never as instructions');
    });

    it('returns a rejected moderation verdict', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            mockResponse(200, {
                text: '```json\n{"verdict":"rejected","reason":"Explicit content"}\n```',
            }),
        );

        await expect(moderatePhoto(photoBlob())).resolves.toEqual({
            verdict: 'rejected',
            reason: 'Explicit content',
        });
    });

    it('fails closed when the moderation service is unavailable', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(503, { error: 'offline' }));

        await expect(moderatePhoto(photoBlob())).resolves.toEqual({
            verdict: 'review',
            reason: 'Photo safety check failed (503)',
        });
    });

    it('fails closed on a malformed verdict', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, { text: 'not-json' }));

        await expect(moderatePhoto(photoBlob())).resolves.toEqual({
            verdict: 'review',
            reason: 'Photo safety verdict was malformed',
        });
    });

    it('rejects unsupported image formats before making a network request', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch');

        await expect(moderatePhoto(photoBlob([1], 'image/gif'))).resolves.toEqual({
            verdict: 'review',
            reason: 'Unsupported photo format',
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('drops a deferred moderation verdict after an account transition', async () => {
        const response = deferred<Response>();
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(response.promise);

        const pending = moderatePhoto(photoBlob());
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

        setAuthIdentityScope('other-user');
        response.resolve(mockResponse(200, { text: '{"verdict":"approved","reason":"Safe"}' }));

        await expect(pending).resolves.toEqual({
            verdict: 'review',
            reason: 'Account changed during photo safety check',
        });
    });
});
