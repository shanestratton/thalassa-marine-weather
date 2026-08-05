/**
 * A scheduled network refresh may run only while the document is active, the
 * app-level WAN reachability probe says online, and its owner is still live.
 * This deliberately does not consult `navigator.onLine`: boat Wi-Fi without a
 * WAN connection reports that flag as online.
 */
export function canRefreshRainForecast(documentHidden: boolean, isOffline: boolean, cancelled: boolean): boolean {
    return !documentHidden && !isOffline && !cancelled;
}
