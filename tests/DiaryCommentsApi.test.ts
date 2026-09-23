import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPublicDiaryComments, submitPublicDiaryComment } from '../src/diaryCommentsApi';
const fetcher = vi.fn();
const submission = {
    handle: 'serene-summer',
    entry_id: 'entry',
    submission_id: 'idempotency',
    guest_name: 'Marta',
    body: 'Ahoy',
    website: '',
};
beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubGlobal('fetch', fetcher);
    fetcher
        .mockReset()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true, status: 'pending' }), { status: 202 }));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});
describe('credentialless public comment transport', () => {
    it('posts only the guest payload, without account cookies or browser cache', async () => {
        await submitPublicDiaryComment(submission, new AbortController().signal);
        expect(fetcher.mock.calls[0][0]).toBe('https://example.supabase.co/functions/v1/diary-comments');
        expect(fetcher.mock.calls[0][1]).toMatchObject({
            method: 'POST',
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(submission),
        });
    });
    it('keeps only bounded well-formed approved read records', async () => {
        fetcher.mockResolvedValue(
            new Response(
                JSON.stringify({
                    comments: [
                        { id: 'one', guest_name: 'Marta', body: 'Hello', created_at: '2026-09-20T00:00:00Z' },
                        { body: 'malformed' },
                    ],
                }),
            ),
        );
        expect(await readPublicDiaryComments('serene-summer', 'entry', new AbortController().signal)).toHaveLength(1);
    });
    it('does not expose upstream database errors to guests', async () => {
        fetcher.mockResolvedValue(
            new Response(JSON.stringify({ error: 'secret database internals' }), { status: 503 }),
        );
        await expect(submitPublicDiaryComment(submission, new AbortController().signal)).rejects.toThrow(
            'temporarily unavailable',
        );
    });
    it('times out a hung request while allowing the UI to retry its same submission id', async () => {
        vi.useFakeTimers();
        fetcher.mockImplementation(
            (_url, options) =>
                new Promise((_resolve, reject) =>
                    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
                ),
        );
        const result = expect(submitPublicDiaryComment(submission, new AbortController().signal)).rejects.toThrow(
            'timed out',
        );
        await vi.advanceTimersByTimeAsync(15_000);
        await result;
        expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    });
});
