export interface ShoreConsentLink {
    action: 'confirm' | 'revoke';
    nonce: string;
}
/** This dependency-free module is evaluated before Sentry/app boot. */
export function takeShoreConsentLink(
    location: Pick<Location, 'hash' | 'pathname' | 'search'>,
    history: Pick<History, 'replaceState'>,
): ShoreConsentLink | null {
    const match = /^#shore=(confirm|revoke)\.([a-f\d]{64})$/.exec(location.hash);
    if (!match) return null;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return { action: match[1] as 'confirm' | 'revoke', nonce: match[2] };
}
// Retain the native method before Sentry can wrap History. Otherwise clearing a
// later hash could itself create a breadcrumb containing the pre-clear bearer.
const privateHistory =
    typeof window === 'undefined' ? null : { replaceState: window.history.replaceState.bind(window.history) };
let pending: ShoreConsentLink | null =
    typeof window === 'undefined' || !privateHistory ? null : takeShoreConsentLink(window.location, privateHistory);
const listeners = new Set<() => void>();
const notify = () => {
    for (const listener of listeners) listener();
};
export const pendingShoreConsent = () => pending;
export const subscribeShoreConsent = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
export const clearShoreConsent = (expected?: ShoreConsentLink) => {
    if (expected && pending !== expected) return;
    pending = null;
    notify();
};
export function redactShoreConsent(expected: ShoreConsentLink): ShoreConsentLink | null {
    if (pending !== expected) return null;
    pending = { action: expected.action, nonce: '' };
    notify();
    return pending;
}
if (typeof window !== 'undefined')
    window.addEventListener(
        'hashchange',
        (event) => {
            const next = takeShoreConsentLink(window.location, privateHistory!);
            if (!next) return;
            // hashchange.newURL itself contains the original bearer. Stop that event
            // before any later telemetry listener can serialize it; publish no event data.
            event.stopImmediatePropagation();
            pending = next;
            notify();
        },
        { capture: true },
    );
