/**
 * fetchWithRetry.test.ts — Tests for the resilient fetch utility.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry, fetchJsonWithRetry } from '../utils/fetchWithRetry';

describe('fetchWithRetry', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should return response on first try success', async () => {
        fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
        const res = await fetchWithRetry('https://example.com');
        expect(res.ok).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should retry on 500 error and succeed on second try', async () => {
        fetchSpy
            .mockResolvedValueOnce(new Response('fail', { status: 500, statusText: 'Internal Server Error' }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const res = await fetchWithRetry('https://example.com', undefined, {
            maxRetries: 2,
            baseDelayMs: 10,
        });
        expect(res.ok).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry on 4xx client errors', async () => {
        fetchSpy.mockResolvedValueOnce(new Response('bad request', { status: 400 }));
        const res = await fetchWithRetry('https://example.com', undefined, {
            maxRetries: 3,
            baseDelayMs: 10,
        });
        expect(res.status).toBe(400);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should retry on network errors', async () => {
        fetchSpy
            .mockRejectedValueOnce(new Error('Network error'))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const res = await fetchWithRetry('https://example.com', undefined, {
            maxRetries: 2,
            baseDelayMs: 10,
        });
        expect(res.ok).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should throw after exhausting retries', async () => {
        fetchSpy.mockRejectedValue(new Error('Network error'));

        await expect(
            fetchWithRetry('https://example.com', undefined, {
                maxRetries: 2,
                baseDelayMs: 10,
            }),
        ).rejects.toThrow('Network error');
        expect(fetchSpy).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should call onRetry callback', async () => {
        const onRetry = vi.fn();
        fetchSpy.mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce(new Response('ok', { status: 200 }));

        await fetchWithRetry('https://example.com', undefined, {
            maxRetries: 2,
            baseDelayMs: 10,
            onRetry,
        });
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
    });
});

describe('fetchJsonWithRetry', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should parse JSON response', async () => {
        const data = { foo: 'bar', count: 42 };
        fetchSpy.mockResolvedValueOnce(
            new Response(JSON.stringify(data), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        const result = await fetchJsonWithRetry<typeof data>('https://example.com');
        expect(result).toEqual(data);
    });

    it('should throw on non-OK response after retries', async () => {
        fetchSpy.mockResolvedValue(new Response('error', { status: 503, statusText: 'Service Unavailable' }));
        await expect(
            fetchJsonWithRetry('https://example.com', undefined, { maxRetries: 1, baseDelayMs: 10 }),
        ).rejects.toThrow('503');
    });
});
