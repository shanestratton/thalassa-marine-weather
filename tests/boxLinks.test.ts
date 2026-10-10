/**
 * Box links reaching the app (126-11b): a tag held to the phone, or a tapped
 * https://www.thalassawx.app/box/<id>, opens Ship's Stores on that box.
 *
 * What Shane was told, 2026-10-09: "Hold the unlocked phone to the box, tap the
 * notification, and Thalassa opens on that box with everything in it". The
 * request belongs to the account signed in when the link arrived: another
 * account on the same phone never opens it.
 *
 * iOS hands the link over twice on a cold start (Capacitor's appUrlOpen,
 * retained until a listener takes it, and App.getLaunchUrl), so one link must
 * open one box; but a skipper holding the phone to the same box twice means it
 * twice. The association file gives the app every /box/ link on the host, so a
 * broken one is told it isn't a box tag rather than nothing happening.
 * Fictional ids, made here; the host is the same in every country.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type UrlListener = (event: { url: string }) => void;

const app = vi.hoisted(() => ({
    listeners: [] as UrlListener[],
    launchUrl: undefined as string | undefined,
    addListener: vi.fn(),
    getLaunchUrl: vi.fn(),
}));

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: app.addListener,
        getLaunchUrl: app.getLaunchUrl,
    },
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock('../components/Toast', () => ({ toast: { error: toastError } }));
const NOT_A_BOX_TAG = "This tag isn't a box tag from Thalassa.";

type Modules = {
    links: typeof import('../services/boxLinks');
    scope: typeof import('../services/authIdentityScope');
    ui: typeof import('../stores/uiStore');
};

const SKIPPER = '3f2e1d0c-9b8a-4765-8432-10fedcba9876';
const OTHER = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';

async function load(): Promise<Modules> {
    vi.resetModules();
    const scope = await import('../services/authIdentityScope');
    scope.setAuthIdentityScope(SKIPPER);
    const ui = await import('../stores/uiStore');
    ui.useUIStore.setState({ currentView: 'dashboard', previousView: 'dashboard' });
    const links = await import('../services/boxLinks');
    return { links, scope, ui };
}

/** Let the dynamic imports and the plugin promises settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function countOpens(event: string): () => number {
    let opens = 0;
    window.addEventListener(event, () => (opens += 1));
    return () => opens;
}

const link = (id: string) => `https://www.thalassawx.app/box/${id}`;

beforeEach(() => {
    localStorage.clear();
    toastError.mockReset();
    app.listeners = [];
    app.launchUrl = undefined;
    app.addListener.mockReset().mockImplementation(async (name: string, listener: UrlListener) => {
        if (name === 'appUrlOpen') app.listeners.push(listener);
        return { remove: vi.fn() };
    });
    app.getLaunchUrl.mockReset().mockImplementation(async () => (app.launchUrl ? { url: app.launchUrl } : undefined));
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('a box link from iOS', () => {
    it('while signed in opens Ship’s Stores, with the box waiting for THIS account', async () => {
        const { links, ui } = await load();
        links.installBoxLinks();
        await settle();
        const id = randomUUID();
        app.listeners.forEach((listener) => listener({ url: link(id) }));
        await settle();
        expect(ui.useUIStore.getState().currentView).toBe('inventory');
        expect(links.consumePendingBox()).toBe(id);
        // Taken once.
        expect(links.consumePendingBox()).toBeNull();
    });

    it('getLaunchUrl and appUrlOpen with the same link open the box once', async () => {
        const { links } = await load();
        const id = randomUUID();
        app.launchUrl = link(id);
        const opens = countOpens(links.OPEN_BOX_EVENT);
        links.installBoxLinks();
        await settle();
        // The retained cold-start event arrives too.
        app.listeners.forEach((listener) => listener({ url: link(id) }));
        await settle();
        expect(opens()).toBe(1);
        expect(links.consumePendingBox()).toBe(id);
        expect(links.consumePendingBox()).toBeNull();
    });

    it('the retained event first and then getLaunchUrl is still one open, even with no storage', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage unavailable');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('storage unavailable');
        });
        const { links } = await load();
        const id = randomUUID();
        app.launchUrl = link(id);
        // Capacitor hands a retained event over as the listener is added, before getLaunchUrl answers.
        app.addListener.mockImplementation(async (name: string, listener: UrlListener) => {
            if (name === 'appUrlOpen') listener({ url: link(id) });
            return { remove: vi.fn() };
        });
        const opens = countOpens(links.OPEN_BOX_EVENT);
        links.installBoxLinks();
        await settle();
        expect(opens()).toBe(1);
        expect(links.consumePendingBox()).toBe(id);
    });

    it('the same box held to the phone again a second later opens it again', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { links } = await load();
        const opens = countOpens(links.OPEN_BOX_EVENT);
        links.installBoxLinks();
        await settle();
        const id = randomUUID();
        app.listeners.forEach((listener) => listener({ url: link(id) }));
        expect(links.consumePendingBox()).toBe(id);
        // A stray swipe closed the box; she holds the phone to it again.
        vi.setSystemTime(Date.now() + 1_000);
        app.listeners.forEach((listener) => listener({ url: link(id) }));
        expect(opens()).toBe(2);
        expect(links.consumePendingBox()).toBe(id);
    });

    it('after a cold start from a tag, the same tag again opens it again', async () => {
        const { links } = await load();
        const id = randomUUID();
        app.launchUrl = link(id);
        const opens = countOpens(links.OPEN_BOX_EVENT);
        links.installBoxLinks();
        await settle();
        app.listeners.forEach((listener) => listener({ url: link(id) }));
        expect(opens()).toBe(1);
        app.listeners.forEach((listener) => listener({ url: link(id) }));
        expect(opens()).toBe(2);
    });

    it('a web view reloaded after iOS killed it does not reopen the last box from getLaunchUrl', async () => {
        const first = await load();
        const id = randomUUID();
        first.links.installBoxLinks();
        await settle();
        app.listeners.forEach((listener) => listener({ url: link(id) }));
        await settle();
        expect(first.links.consumePendingBox()).toBe(id);

        // The same app process, a fresh web view: iOS still reports the old link.
        app.listeners = [];
        app.launchUrl = link(id);
        const again = await load();
        const opens = countOpens(again.links.OPEN_BOX_EVENT);
        again.links.installBoxLinks();
        await settle();
        expect(opens()).toBe(0);
        expect(again.links.consumePendingBox()).toBeNull();
        expect(again.ui.useUIStore.getState().currentView).toBe('dashboard');
    });

    it('a link that arrived for another account is dropped when the account changes', async () => {
        const { links, scope } = await load();
        links.installBoxLinks();
        await settle();
        app.listeners.forEach((listener) => listener({ url: link(randomUUID()) }));
        scope.setAuthIdentityScope(OTHER);
        expect(links.consumePendingBox()).toBeNull();
    });

    it('a link made before sign-out never opens for the next person', async () => {
        const { links, scope } = await load();
        links.installBoxLinks();
        await settle();
        app.listeners.forEach((listener) => listener({ url: link(randomUUID()) }));
        scope.setAuthIdentityScope(null);
        scope.setAuthIdentityScope(OTHER);
        expect(links.consumePendingBox()).toBeNull();
    });

    it('any other link changes nothing: no page, no request, no event', async () => {
        const { links, ui } = await load();
        const opens = countOpens(links.OPEN_BOX_EVENT);
        links.installBoxLinks();
        await settle();
        for (const url of [
            'com.googleusercontent.apps.example:/oauth2redirect?code=abc&state=def',
            'https://www.thalassawx.app/plan',
            'https://www.thalassawx.app/boxes',
            `https://serene-example.thalassawx.app/box/${randomUUID()}`,
            `https://www.example.org/box/${randomUUID()}`,
        ]) {
            app.listeners.forEach((listener) => listener({ url }));
        }
        await settle();
        expect(opens()).toBe(0);
        expect(links.consumePendingBox()).toBeNull();
        expect(ui.useUIStore.getState().currentView).toBe('dashboard');
        // Not ours, so not a word: the Gmail connect redirect has its own listener.
        expect(toastError).not.toHaveBeenCalled();
    });

    it('a broken box link on the box host says it is not a box tag, and opens nothing', async () => {
        const { links, ui } = await load();
        const opens = countOpens(links.OPEN_BOX_EVENT);
        links.installBoxLinks();
        await settle();
        const id = randomUUID();
        for (const url of [
            `https://www.thalassawx.app/box/${id}/`,
            'https://www.thalassawx.app/box/spares',
            `https://www.thalassawx.app/box/${id}?from=tag`,
        ]) {
            app.listeners.forEach((listener) => listener({ url }));
        }
        await settle();
        expect(toastError).toHaveBeenCalledTimes(3);
        expect(toastError).toHaveBeenCalledWith(NOT_A_BOX_TAG);
        expect(opens()).toBe(0);
        expect(links.consumePendingBox()).toBeNull();
        expect(ui.useUIStore.getState().currentView).toBe('dashboard');
    });

    it('a broken box link that launched the app says so too, once', async () => {
        const { links } = await load();
        app.launchUrl = 'https://www.thalassawx.app/box/spares';
        links.installBoxLinks();
        await settle();
        app.listeners.forEach((listener) => listener({ url: 'https://www.thalassawx.app/box/spares' }));
        await settle();
        expect(toastError).toHaveBeenCalledTimes(1);
        expect(toastError).toHaveBeenCalledWith(NOT_A_BOX_TAG);
    });

    it('installBoxLinks listens once however often it is called', async () => {
        const { links } = await load();
        links.installBoxLinks();
        links.installBoxLinks();
        await settle();
        links.installBoxLinks();
        await settle();
        expect(app.addListener).toHaveBeenCalledTimes(1);
        expect(app.addListener).toHaveBeenCalledWith('appUrlOpen', expect.any(Function));
        expect(app.getLaunchUrl).toHaveBeenCalledTimes(1);
    });

    it('a missing App plugin is quiet: the app boots on', async () => {
        const { links } = await load();
        app.addListener.mockRejectedValueOnce(new Error('not implemented'));
        expect(() => links.installBoxLinks()).not.toThrow();
        await settle();
        expect(links.consumePendingBox()).toBeNull();
    });
});
