// @vitest-environment node
/** Pure fake-host I/O fence fixtures, not an actual browser, App bootstrap,
 * Supabase SDK, native transport or security-sandbox acceptance test. */
import { describe, expect, it, vi } from 'vitest';
import { createFullAppIoFence } from '../experiments/scuttlebutt-e2ee/full-app-pilot/ioFence';

const URL = 'https://kmtupdvwdgbhtssqqova.supabase.co/auth/v1/token';
function hostFixture() {
    const originalFetch = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    const preservedFetch = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    const originalXhr = vi.fn(),
        originalSocket = vi.fn(),
        originalBeacon = vi.fn();
    const localGetter = vi.fn(() => ({ getItem: () => 'synthetic old cache' }));
    const listeners = new Map<string, (event: Event) => void>();
    const host = {
        fetch: originalFetch,
        CapacitorWebFetch: preservedFetch,
        Request,
        Response,
        XMLHttpRequest: originalXhr,
        WebSocket: originalSocket,
        navigator: { sendBeacon: originalBeacon },
        document: {
            addEventListener: vi.fn((type: string, callback: (event: Event) => void) => listeners.set(type, callback)),
        },
        location: { assign: vi.fn(), replace: vi.fn(), reload: vi.fn() },
        HTMLFormElement: { prototype: {} },
        HTMLMediaElement: { prototype: {} },
    } as Record<string, unknown>;
    Object.defineProperty(host, 'localStorage', { configurable: true, get: localGetter });
    const fence = createFullAppIoFence(host);
    return {
        host,
        fence,
        originalFetch,
        preservedFetch,
        originalXhr,
        originalSocket,
        originalBeacon,
        localGetter,
        listeners,
    };
}
const object = (value: unknown) => value as Record<string, unknown>;
const call = (target: unknown, name: string) => (object(target)[name] as () => unknown)();

describe('full App early I/O fence — fake-host isolation checks only', () => {
    it('does no I/O during factory creation and refuses the SDK capability until installation', async () => {
        const f = hostFixture();
        expect(f.fence.evidence().status).toBe('uninstalled');
        expect(f.originalFetch).not.toHaveBeenCalled();
        expect(f.preservedFetch).not.toHaveBeenCalled();
        expect(f.localGetter).not.toHaveBeenCalled();
        expect(f.listeners.size).toBe(0);
        await expect(f.fence.researchAuthFetch(URL + '?grant_type=password', { method: 'POST' })).rejects.toThrow(
            'Full App fixture I/O refused',
        );
        expect(f.preservedFetch).not.toHaveBeenCalled();
    });
    it('irreversibly blocks ordinary transports and preserved browser aliases without invoking originals', async () => {
        const f = hostFixture();
        f.fence.install();
        f.fence.install();
        await expect((f.host.fetch as typeof fetch)('https://synthetic.invalid')).rejects.toThrow(
            'Full App fixture I/O refused',
        );
        await expect((f.host.CapacitorWebFetch as typeof fetch)('https://synthetic.invalid')).rejects.toThrow(
            'Full App fixture I/O refused',
        );
        for (const name of [
            'XMLHttpRequest',
            'WebSocket',
            'EventSource',
            'Worker',
            'SharedWorker',
            'CapacitorWebXMLHttpRequest',
            'Audio',
            'AudioContext',
            'RTCPeerConnection',
            'WebTransport',
        ]) {
            const Constructor = f.host[name] as new () => object;
            expect(() => new Constructor()).toThrow('Full App fixture I/O refused');
            expect(Object.getOwnPropertyDescriptor(f.host, name)).toMatchObject({
                configurable: false,
                writable: false,
            });
        }
        expect(() => call(f.host.navigator, 'sendBeacon')).toThrow('Full App fixture I/O refused');
        expect(Reflect.set(f.host, 'fetch', f.originalFetch)).toBe(false);
        for (const original of [f.originalFetch, f.preservedFetch, f.originalXhr, f.originalSocket, f.originalBeacon])
            expect(original).not.toHaveBeenCalled();
        expect(f.fence.evidence().status).toBe('installed');
    });
    it('blocks asynchronous APIs, hardware requests and direct navigation helpers', async () => {
        const f = hostFixture();
        f.fence.install();
        const nav = object(f.host.navigator);
        for (const [target, method] of [
            [f.host.caches, 'open'],
            [nav.serviceWorker, 'register'],
            [nav.permissions, 'query'],
            [nav.storage, 'getDirectory'],
            [nav.mediaDevices, 'getUserMedia'],
            [nav.clipboard, 'readText'],
            [nav, 'share'],
            [object(f.host.HTMLMediaElement).prototype, 'play'],
        ] as const)
            await expect(call(target, method)).rejects.toThrow('Full App fixture I/O refused');
        for (const [target, method] of [
            [f.host.indexedDB, 'open'],
            [nav.geolocation, 'getCurrentPosition'],
            [f.host, 'open'],
            [f.host.location, 'assign'],
            [object(f.host.HTMLFormElement).prototype, 'submit'],
            [f.host.speechSynthesis, 'speak'],
            [f.host.document, 'execCommand'],
        ] as const)
            expect(() => call(target, method)).toThrow('Full App fixture I/O refused');
        expect(f.fence.evidence().counts.media).toBe(1);
        expect(f.fence.evidence().counts.clipboard).toBe(2);
    });
    it('uses fresh bounded memory Storage without reading or writing the original cache', () => {
        const f = hostFixture();
        f.fence.install();
        const local = f.host.localStorage as Storage,
            session = f.host.sessionStorage as Storage;
        expect(local.getItem('old')).toBeNull();
        expect(f.localGetter).not.toHaveBeenCalled();
        local.setItem('one', 'synthetic cache');
        expect(local.getItem('one')).toBe('synthetic cache');
        expect(session.getItem('one')).toBeNull();
        expect(local.key(0)).toBe('one');
        expect(local.length).toBe(1);
        local.setItem('one', 'replacement');
        expect(local.length).toBe(1);
        expect(() => local.setItem('oversized', 'x'.repeat(65537))).toThrow('Full App fixture I/O refused');
        expect(() => local.setItem('x'.repeat(1025), 'value')).toThrow('Full App fixture I/O refused');
        local.removeItem('one');
        expect(local.length).toBe(0);
        for (let index = 0; index < 128; index += 1) local.setItem(String(index), 'value');
        expect(() => local.setItem('129th', 'value')).toThrow('Full App fixture I/O refused');
        local.clear();
        expect(local.length).toBe(0);
        for (let index = 0; index < 3; index += 1) local.setItem(String(index), 'x'.repeat(65536));
        expect(() => local.setItem('four', 'x'.repeat(65536))).toThrow('Full App fixture I/O refused');
        expect(f.fence.evidence().counts.storageRefused).toBe(4);
    });
    it.each(['password', 'refresh_token'])(
        'privately permits only pinned token POST %s and forces safe request options',
        async (grant) => {
            const f = hostFixture();
            f.fence.install();
            const response = await f.fence.researchAuthFetch(URL + '?grant_type=' + grant, {
                method: 'POST',
                body: '{}',
                credentials: 'include',
                redirect: 'follow',
            });
            expect(response.status).toBe(200);
            expect(f.originalFetch).not.toHaveBeenCalled();
            expect(f.preservedFetch).toHaveBeenCalledTimes(1);
            const request = f.preservedFetch.mock.calls[0]?.[0] as unknown as Request;
            expect(request.method).toBe('POST');
            expect(request.url).toBe(URL + '?grant_type=' + grant);
            expect(request.redirect).toBe('error');
            expect(request.credentials).toBe('omit');
            expect(request.cache).toBe('no-store');
            expect(request.mode).toBe('cors');
            expect(f.fence.evidence().counts.authRequests).toBe(1);
            expect(f.fence.evidence().counts.authResponses).toBe(1);
        },
    );
    it.each([
        [URL + '?grant_type=password', 'GET'],
        [URL + '?grant_type=authorization_code', 'POST'],
        [URL + '?grant_type=password&extra=true', 'POST'],
        [URL + '?grant_type=password#fragment', 'POST'],
        [URL + '?grant_type=password&grant_type=refresh_token', 'POST'],
        [URL.replace('https:', 'http:') + '?grant_type=password', 'POST'],
        ['https://synthetic.invalid/auth/v1/token?grant_type=password', 'POST'],
    ])('refuses noncanonical or unexpected Auth capability requests %s %s', async (url, method) => {
        const f = hostFixture();
        f.fence.install();
        await expect(f.fence.researchAuthFetch(url, { method })).rejects.toThrow('Full App fixture I/O refused');
        expect(f.preservedFetch).not.toHaveBeenCalled();
        expect(f.fence.evidence().counts.authRequests).toBe(0);
        expect(f.fence.evidence().counts.authRefused).toBe(1);
    });
    it('falls back to private original fetch when no preserved alias exists', async () => {
        const original = vi.fn(async () => new Response('{}'));
        const f = hostFixture();
        delete f.host.CapacitorWebFetch;
        f.host.fetch = original;
        const fence = createFullAppIoFence(f.host);
        fence.install();
        await fence.researchAuthFetch(URL + '?grant_type=password', { method: 'POST' });
        expect(original).toHaveBeenCalledTimes(1);
        expect(f.host.fetch).not.toBe(original);
    });
    it('refuses redirect responses and suppresses original transport errors', async () => {
        const f = hostFixture();
        f.fence.install();
        f.preservedFetch.mockResolvedValueOnce(new Response(null, { status: 302 }));
        await expect(f.fence.researchAuthFetch(URL + '?grant_type=password', { method: 'POST' })).rejects.toThrow(
            'Full App fixture I/O refused',
        );
        f.preservedFetch.mockRejectedValueOnce(new Error('synthetic private details must never escape'));
        await expect(f.fence.researchAuthFetch(URL + '?grant_type=password', { method: 'POST' })).rejects.toThrow(
            'Full App fixture I/O refused',
        );
        expect(f.fence.evidence().counts.authResponses).toBe(0);
        expect(f.fence.evidence().counts.authRefused).toBe(2);
    });
    it('refuses opaque or error responses and response URL changes without returning unreadable Auth data', async () => {
        const f = hostFixture();
        f.fence.install();
        for (const [type, status, url] of [
            ['opaque', 0, ''],
            ['error', 0, ''],
            ['basic', 200, 'https://synthetic.invalid'],
        ] as const) {
            f.preservedFetch.mockResolvedValueOnce({ type, status, url, redirected: false } as Response);
            await expect(f.fence.researchAuthFetch(URL + '?grant_type=password', { method: 'POST' })).rejects.toThrow(
                'Full App fixture I/O refused',
            );
        }
        expect(f.fence.evidence().counts.authRequests).toBe(3);
        expect(f.fence.evidence().counts.authResponses).toBe(0);
        expect(f.fence.evidence().counts.authRefused).toBe(3);
    });
    it('fails closed on an unpatchable critical transport and refuses its captured SDK capability', async () => {
        const f = hostFixture();
        Object.defineProperty(f.host, 'fetch', { value: f.originalFetch, writable: false, configurable: false });
        expect(() => f.fence.install()).toThrow('Full App fixture I/O fence unavailable');
        expect(f.fence.evidence().status).toBe('failed');
        expect(f.fence.evidence().counts.patchFailures).toBe(1);
        await expect(f.fence.researchAuthFetch(URL + '?grant_type=password', { method: 'POST' })).rejects.toThrow(
            'Full App fixture I/O refused',
        );
        expect(f.preservedFetch).not.toHaveBeenCalled();
    });
    it('documents Location assignment limitations while blocking ordinary link/form defaults', () => {
        const f = hostFixture();
        Object.defineProperty(object(f.host.location), 'assign', {
            configurable: false,
            writable: false,
            value: () => undefined,
        });
        f.fence.install();
        expect(f.fence.evidence().counts.locationPatchUnavailable).toBe(1);
        const click = {
            type: 'click',
            target: { closest: () => ({ getAttribute: () => 'https://synthetic.invalid' }) },
            preventDefault: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        };
        f.listeners.get('click')!(click as unknown as Event);
        expect(click.preventDefault).toHaveBeenCalledTimes(1);
        expect(click.stopImmediatePropagation).toHaveBeenCalledTimes(1);
        for (const type of ['auxclick', 'contextmenu']) {
            const event = { ...click, type, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
            f.listeners.get(type)!(event as unknown as Event);
            expect(event.preventDefault).toHaveBeenCalledTimes(1);
        }
        const svgLink = {
            ...click,
            target: {
                closest: () => ({
                    getAttribute: (name: string) => (name === 'xlink:href' ? 'https://synthetic.invalid' : null),
                }),
            },
            preventDefault: vi.fn(),
        };
        f.listeners.get('click')!(svgLink as unknown as Event);
        expect(svgLink.preventDefault).toHaveBeenCalledTimes(1);
        const submit = { type: 'submit', preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
        f.listeners.get('submit')!(submit as unknown as Event);
        expect(submit.preventDefault).toHaveBeenCalledTimes(1);
        expect(submit.stopImmediatePropagation).not.toHaveBeenCalled(); // Research React submit handler remains usable.
    });
    it('returns only fixed bounded counts and fixed status, without URLs, arguments, errors or storage contents', async () => {
        const f = hostFixture();
        f.fence.install();
        (f.host.localStorage as Storage).setItem('synthetic-private-key', 'synthetic-private-content');
        for (let index = 0; index < 10005; index += 1) {
            try {
                call(f.host, 'open');
            } catch {
                /* fixed refusal */
            }
        }
        const evidence = f.fence.evidence();
        expect(evidence.counts.navigation).toBe(10000);
        expect(Object.isFrozen(evidence)).toBe(true);
        expect(Object.isFrozen(evidence.counts)).toBe(true);
        const serialized = JSON.stringify(evidence);
        expect(serialized).not.toContain('https://');
        expect(serialized).not.toContain('synthetic-private');
        expect(
            Object.values(evidence.counts).every((value) => Number.isInteger(value) && value >= 0 && value <= 10000),
        ).toBe(true);
    });
});
