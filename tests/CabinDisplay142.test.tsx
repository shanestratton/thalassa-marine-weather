import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CabinDisplay } from '../pi-cache/cabin/main';
import { readCabinJson } from '../pi-cache/cabin/browserRead';
import type { CabinSnapshot } from '../pi-cache/src/cabin/wire';
const token = 'cabin-' + 'a'.repeat(64);
const snapshot = (heading = 82): CabinSnapshot => ({
    schema: 1,
    servedAt: Date.now(),
    reportedAt: Date.now() - 1_000,
    available: true,
    anchor: null,
    readings: { heading, pressure: 1012, depth: 4.8, speed: 5.3, wind: 17 },
    watch: null,
});
const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
const pair = async () => {
    fireEvent.change(screen.getByLabelText('Cabin code'), { target: { value: '12345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show instruments' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show instruments' })).toBeNull());
};

describe('actual cabin page read-only lifetime', () => {
    it('reuses real dials, keeps bearer only in memory and sends only pair/read requests', async () => {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
        const fetcher = vi.fn(async (url: RequestInfo | URL) =>
            String(url) === '/api/cabin/pair' ? json({ token, expiresAt: Date.now() + 60_000 }) : json(snapshot()),
        );
        vi.stubGlobal('fetch', fetcher);
        render(<CabinDisplay />);
        await pair();
        await screen.findByRole('img', { name: /Heading from Pi, 082 degrees/ });
        expect(screen.getByText('4.8')).toBeTruthy();
        expect(screen.queryAllByRole('button', { name: /arm|silence|stand.down|acknowledge/i })).toHaveLength(0);
        expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual(['/api/cabin/pair', '/api/telemetry']);
        expect(localStorage.length).toBe(0);
        expect(sessionStorage.length).toBe(0);
    });
    it('hiding cancels its reader; a late response cannot restore stale data or an old alarm', async () => {
        let hidden = false,
            finish: ((response: Response) => void) | null = null,
            reads = 0;
        vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
        const fetcher = vi.fn((url: RequestInfo | URL) => {
            if (String(url) === '/api/cabin/pair') return Promise.resolve(json({ token }));
            reads++;
            return reads === 1
                ? new Promise<Response>((resolve) => {
                      finish = resolve;
                  })
                : Promise.resolve(json(snapshot(47)));
        });
        vi.stubGlobal('fetch', fetcher);
        render(<CabinDisplay />);
        await pair();
        await waitFor(() => expect(reads).toBe(1));
        hidden = true;
        fireEvent(document, new Event('visibilitychange'));
        const old = snapshot(82);
        await act(async () => {
            if (!finish) throw Error('Missing reader');
            finish(json(old));
            await Promise.resolve();
        });
        expect(screen.queryByRole('img', { name: /082 degrees/ })).toBeNull();
        hidden = false;
        fireEvent(document, new Event('visibilitychange'));
        await screen.findByRole('img', { name: /Heading from Pi, 047 degrees/ });
        expect(reads).toBe(2);
    });
    it('a retired server credential clears readings and returns to pairing without sending a command', async () => {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: RequestInfo | URL) =>
                String(url) === '/api/cabin/pair' ? json({ token }) : new Response(null, { status: 401 }),
            ),
        );
        render(<CabinDisplay />);
        await pair();
        await screen.findByRole('heading', { name: 'Pair this display' });
        expect(screen.queryByRole('img', { name: /082 degrees/ })).toBeNull();
    });
});
describe('bounded browser response admission', () => {
    it('refuses a zero-byte chunk stream without a timer-starving read loop', async () => {
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(0));
            },
        });
        await expect(readCabinJson(new Response(body), 512, new AbortController().signal)).rejects.toThrow(
            /chunk limit/,
        );
    });
    it('accepts an exact bounded body and refuses bytes beyond its cap before parsing', async () => {
        expect(await readCabinJson(json({ ok: true }), 512, new AbortController().signal)).toEqual({ ok: true });
        await expect(readCabinJson(new Response('x'.repeat(513)), 512, new AbortController().signal)).rejects.toThrow(
            /limit/,
        );
    });
    it('abort wins a never-resolving native read and initiates cancellation without awaiting it', async () => {
        let cancelled = 0;
        const body = new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => {}),
            cancel: () => {
                cancelled++;
                return new Promise(() => {});
            },
        });
        const controller = new AbortController(),
            pending = readCabinJson(new Response(body), 512, controller.signal);
        controller.abort();
        await expect(pending).rejects.toThrow(/retired/);
        expect(cancelled).toBe(1);
    });
});
