/** Synchronous transformRequest bridge. Hydration/download/storage stay in the lazy service. */
const localUrls = new Map<string, string>();
const listeners = new Set<() => void>();
let used: ((url: string) => void) | undefined;
export function offlineReliefUrl(url: string): string | null {
    const value = localUrls.get(url) ?? null;
    if (value) used?.(url);
    return value;
}
export function onOfflineReliefUse(listener: (url: string) => void) {
    used = listener;
}
export function publishOfflineRelief(urls: ReadonlyMap<string, string>) {
    localUrls.clear();
    for (const [url, local] of urls) localUrls.set(url, local);
    for (const listener of listeners) listener();
}
export function subscribeOfflineRelief(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
