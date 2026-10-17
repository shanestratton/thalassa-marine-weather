import { isAuthIdentityScopeCurrent, subscribeAuthIdentityScope, type AuthIdentityScope } from './authIdentityScope';
export const OPEN_GPX_EVENT = 'thalassa:open-gpx';
let pending: { file: File; scope: AuthIdentityScope } | null = null;
subscribeAuthIdentityScope(() => {
    pending = null;
});
export function clearOpenedGpx(): void {
    pending = null;
}
export function stageOpenedGpx(file: File, scope: AuthIdentityScope): void {
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('GPX import stopped.');
    pending = { file, scope };
    window.dispatchEvent(new Event(OPEN_GPX_EVENT));
}
/** A preview acknowledges only after its asynchronous read, preserving React's remount handoff. */
export function peekOpenedGpx(): File | null {
    return pending && isAuthIdentityScopeCurrent(pending.scope) ? pending.file : null;
}
export function finishOpenedGpx(file: File): void {
    if (pending?.file === file) pending = null;
}
