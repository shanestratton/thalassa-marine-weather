/** Isolated native owner projection. A denial fact is never PM readiness.
 * No Auth SDK, bearer, enrollment, signed mutation, storage or legacy fallback.
 */
import { getResearchNativeLifecycleChannel, type ResearchNativeLifecycleBindings } from './nativeLifecycle';
export interface ResearchPrivateAdmissionBindings extends ResearchNativeLifecycleBindings {
    currentAccount(options?: { epoch: string }): Promise<unknown>;
    messagePrivateAdmission(options: { credentialBinding: string }): Promise<unknown>;
}
export interface ResearchPrivateAdmissionSource {
    readAdmission(): Promise<unknown>;
    /** View/await fence only. Native owner, history and policy stay unchanged. */
    invalidate(): void;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (value: unknown): value is string =>
    typeof value === 'string' && UUID.exec(value)?.[0] === value && value !== '00000000-0000-0000-0000-000000000000';
function fields(value: unknown, names: string[]): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key)))
        return null;
    const result: Record<string, unknown> = {};
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        result[name] = descriptor.value;
    }
    return result;
}
type Account = { accountId: string; deviceId: string; credentialBinding: string };
function account(value: unknown): Account | null {
    const outer = fields(value, ['status', 'account']);
    if (!outer || outer.status !== 'authenticated') return null;
    const row = fields(outer.account, ['accountId', 'deviceId', 'credentialBinding', 'serverVerified']);
    return row && row.serverVerified === true && id(row.accountId) && id(row.deviceId) && id(row.credentialBinding)
        ? { accountId: row.accountId, deviceId: row.deviceId, credentialBinding: row.credentialBinding }
        : null;
}
const same = (a: Account, b: Account | null) =>
    !!b && a.accountId === b.accountId && a.deviceId === b.deviceId && a.credentialBinding === b.credentialBinding;
const closed = () => Object.freeze({ status: 'unavailable', reason: 'unavailable' });

export function createResearchPrivateAdmissionSource(
    native: ResearchPrivateAdmissionBindings,
): ResearchPrivateAdmissionSource {
    // Capture this composition once; a disposed source cannot adopt a later
    // controller/channel on the same plugin after an asynchronous read.
    const lifecycle = getResearchNativeLifecycleChannel(native);
    const managed = lifecycle
        ? lifecycle.managed
        : typeof native.lifecycleState === 'function' || typeof native.acknowledgeClosedPresentation === 'function';
    const creationEpoch = () => {
        const descriptor = lifecycle?.getState();
        return descriptor?.phase === 'active' && descriptor.verificationAvailable ? descriptor.epoch : undefined;
    };
    const eligible = (epoch: string | undefined) => !managed || (epoch !== undefined && creationEpoch() === epoch);
    let revision = 0,
        busy = false;
    if (managed && lifecycle)
        lifecycle.subscribe((descriptor) => {
            if (descriptor?.phase !== 'active' || !descriptor.verificationAvailable) revision += 1;
        });
    return Object.freeze({
        invalidate() {
            revision += 1;
        },
        async readAdmission() {
            // Bound in-flight native reads. A refused overlapping call cancels
            // publication of the previous read, but cannot free its reservation.
            const ticket = ++revision;
            const epoch = creationEpoch();
            const current = () => ticket === revision && eligible(epoch);
            const readAccount = () =>
                epoch === undefined ? native.currentAccount() : native.currentAccount({ epoch });
            if (busy || !current()) return closed();
            busy = true;
            try {
                if (managed) {
                    const descriptor = await lifecycle!.refresh();
                    if (!current() || descriptor?.epoch !== epoch) return closed();
                }
                const original = account(await readAccount());
                if (!current() || !original) return closed();
                const value = fields(
                    await native.messagePrivateAdmission({ credentialBinding: original.credentialBinding }),
                    ['status', 'accountId', 'deviceId', 'credentialBinding', 'selection'],
                );
                if (
                    !current() ||
                    !value ||
                    value.status !== 'private_admission' ||
                    value.accountId !== original.accountId ||
                    value.deviceId !== original.deviceId ||
                    value.credentialBinding !== original.credentialBinding ||
                    (value.selection !== 'protected-required' && value.selection !== 'unknown')
                )
                    return closed();
                const selection = value.selection;
                // Copy before the await; an adapter-owned mutable result cannot
                // retag this original completion onto a newer credential epoch.
                const latest = account(await readAccount());
                if (!current() || !same(original, latest)) return closed();
                return Object.freeze({ status: 'private_admission', ...original, selection });
            } catch {
                return closed();
            } finally {
                busy = false;
            }
        },
    });
}
