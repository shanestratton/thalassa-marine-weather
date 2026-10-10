/**
 * Box links (126-11b): https://www.thalassawx.app/box/<id>, the only thing on
 * the NFC tag stuck to a Ship's Stores box. Holding an iPhone to the tag (or
 * tapping the link) opens Thalassa on that box.
 *
 * iOS hands the link to Capacitor (SceneDelegate → SceneDelegateProxy), which
 * raises appUrlOpen and keeps it until a listener takes it; getLaunchUrl is
 * asked once as well. A box link becomes a request owned by the account signed
 * in when it arrived (services/authIdentityScope): Ship's Stores takes it on
 * mount, or on OPEN_BOX_EVENT when it is already open, and opens the box with
 * openBox(). Another account never opens it. The association file gives the
 * app every /box/ link on the host, so one that is not a box link (a hand-made
 * tag, a trailing slash) is told "This tag isn't a box tag from Thalassa."
 * rather than nothing happening. Any other link is ignored: it is not ours
 * (the Gmail connect redirect has its own listener).
 *
 * Installed by a native-only dynamic import from ApplicationShell, so it is
 * never in the web's first load, and it shares the shell's page store. The
 * link's format lives with the tags (services/native/nfcTags).
 */
import { App } from '@capacitor/app';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';
import { useUIStore } from '../stores/uiStore';
import { toast } from '../components/Toast';
import { BOX_LINK_PREFIX, NOT_A_BOX_TAG, parseBoxLink } from './native/nfcTags';

/** Sent on window when a box link arrives while Ship's Stores may be open. */
export const OPEN_BOX_EVENT = 'thalassa:open-box';

let pending: { id: string; identity: AuthIdentityScope } | null = null;
let installed = false;
/**
 * The last box link taken on this phone. iOS keeps reporting it from
 * getLaunchUrl for the life of the app process, so a web view reloaded after
 * iOS killed it would take that link again without this.
 */
const OPENED_KEY = 'thalassa.boxLinkOpened';

/** A link from iOS: its box opens, or a /box/ link that is not one says so. Anything else is not ours. */
function take(url: string): void {
    const opened = openBoxLink(url);
    if (!opened && !url.startsWith(BOX_LINK_PREFIX)) return;
    if (!opened) toast.error(NOT_A_BOX_TAG);
    try {
        localStorage.setItem(OPENED_KEY, url);
    } catch {
        /* storage unavailable: only a reloaded web view would open it again */
    }
}

/**
 * Open Ship's Stores on the box in this link, for the account signed in now.
 * Returns false (and changes nothing) for any other link.
 */
export function openBoxLink(url: unknown): boolean {
    const id = parseBoxLink(url);
    if (!id) return false;
    pending = { id, identity: getAuthIdentityScope() };
    // Ship's Stores already open takes it here; otherwise it waits for the page.
    window.dispatchEvent(new Event(OPEN_BOX_EVENT));
    if (pending) useUIStore.getState().setPage('inventory');
    return true;
}

/** The box waiting for the account signed in now, once; null when there is none. */
export function consumePendingBox(): string | null {
    const request = pending;
    pending = null;
    return request && isAuthIdentityScopeCurrent(request.identity) ? request.id : null;
}

// A box id is private to its boat: drop the request the moment the account changes.
subscribeAuthIdentityScope(() => {
    pending = null;
});

/**
 * Listen for box links from iOS, once per launch. Native only (ApplicationShell).
 *
 * A cold start hands the one tap over twice, as the retained appUrlOpen and as
 * getLaunchUrl, in either order: whichever comes second is skipped, once. Every
 * later appUrlOpen is a tap of its own, so the same box held to the phone again
 * opens again.
 */
export function installBoxLinks(): void {
    if (installed) return;
    installed = true;
    /** The first appUrlOpen, and the launch link once taken: the cold start's pair. */
    let first: string | undefined;
    let launched: string | undefined;
    void (async () => {
        await App.addListener('appUrlOpen', ({ url }) => {
            const twin = first === undefined && url === launched;
            first ??= url;
            if (!twin) take(url);
        });
        const launch = (await App.getLaunchUrl())?.url;
        let opened: string | null = null;
        try {
            opened = localStorage.getItem(OPENED_KEY);
        } catch {
            /* no storage: the pair above still holds */
        }
        if (launch && launch !== first && launch !== opened) take((launched = launch));
    })().catch(() => undefined);
}
