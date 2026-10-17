import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { localChartKind } from './localChartLibraryContract';

export const OPEN_CHART_EVENT = 'thalassa:open-local-chart';
interface OpenedChart {
    token: string;
    url: string;
    name: string;
    scope: AuthIdentityScope;
    expires: number;
}
let pending: OpenedChart | null = null;
subscribeAuthIdentityScope(() => {
    pending = null;
});
export function localChartUrlName(raw: string): string {
    if (raw.length > 8192) throw new Error('The chart attachment URL is too long.');
    const url = new URL(raw);
    if (
        url.protocol !== 'file:' ||
        (url.hostname && url.hostname !== 'localhost') ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        throw new Error('Choose a local chart attachment from Mail or Files.');
    const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    localChartKind(name);
    return name;
}
/** URI only; no retained copy or chart read happens before the user's rights choice. */
export function stageOpenedChart(url: string, scope = getAuthIdentityScope()): void {
    const name = localChartUrlName(url);
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Chart attachment stopped.');
    pending = { token: crypto.randomUUID(), url, name, scope, expires: Date.now() + 300_000 };
    window.dispatchEvent(new CustomEvent(OPEN_CHART_EVENT));
}
export function peekOpenedChart(): Readonly<OpenedChart> | null {
    if (!pending || !isAuthIdentityScopeCurrent(pending.scope) || Date.now() >= pending.expires) {
        pending = null;
        return null;
    }
    return pending;
}
export function finishOpenedChart(token: string): void {
    if (pending?.token === token) pending = null;
}
