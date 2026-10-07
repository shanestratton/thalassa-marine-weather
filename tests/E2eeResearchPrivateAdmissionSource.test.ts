// Structural native bridge fixtures only: no SDK, native Auth, storage or E2EE.
import { describe, expect, it, vi } from 'vitest';
import { createResearchPrivateAdmissionSource } from '../experiments/scuttlebutt-e2ee/bridge-web/privateAdmissionSource';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const DEVICE = 'a2000000-0000-4000-8000-000000000001';
const BINDING = 'a3000000-0000-4000-8000-000000000001';
const OTHER = 'a1000000-0000-4000-8000-000000000002';
const CLOSED = { status: 'unavailable', reason: 'unavailable' };
const current = () => ({
    status: 'authenticated',
    account: { accountId: OWNER, deviceId: DEVICE, credentialBinding: BINDING, serverVerified: true },
});
const projection = (selection = 'protected-required') => ({
    status: 'private_admission',
    accountId: OWNER,
    deviceId: DEVICE,
    credentialBinding: BINDING,
    selection,
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
function fixture() {
    const native = {
        currentAccount: vi.fn(async (): Promise<unknown> => current()),
        messagePrivateAdmission: vi.fn(
            async (_options: { credentialBinding: string }): Promise<unknown> => projection(),
        ),
    };
    return { native, source: createResearchPrivateAdmissionSource(native) };
}
describe('isolated native startup projection — denial only', () => {
    it.each(['protected-required', 'unknown'])('copies %s without granting permission', async (selection) => {
        const { native, source } = fixture();
        native.messagePrivateAdmission.mockResolvedValueOnce(projection(selection));
        expect(await source.readAdmission()).toEqual(projection(selection));
        expect(native.currentAccount).toHaveBeenCalledTimes(2);
        expect(native.messagePrivateAdmission).toHaveBeenCalledWith({ credentialBinding: BINDING });
        expect(Object.keys(native.messagePrivateAdmission.mock.calls[0][0])).toEqual(['credentialBinding']);
    });
    it('does nothing on construction or view invalidation', () => {
        const { native, source } = fixture();
        source.invalidate();
        expect(native.currentAccount).not.toHaveBeenCalled();
        expect(native.messagePrivateAdmission).not.toHaveBeenCalled();
    });
    it.each(['legacy-permitted', 'ready', 'encrypted', true, null])(
        'rejects a non-denial selection %s',
        async (selection) => {
            const { native, source } = fixture();
            native.messagePrivateAdmission.mockResolvedValueOnce({ ...projection(), selection });
            expect(await source.readAdmission()).toEqual(CLOSED);
        },
    );
    it.each(['status', 'accountId', 'deviceId', 'credentialBinding', 'selection'])(
        'requires original %s',
        async (key) => {
            const { native, source } = fixture();
            const value = projection();
            Reflect.deleteProperty(value, key);
            native.messagePrivateAdmission.mockResolvedValueOnce(value);
            expect(await source.readAdmission()).toEqual(CLOSED);
        },
    );
    it.each(['accountId', 'deviceId', 'credentialBinding'])('refuses changed %s in the admission', async (key) => {
        const { native, source } = fixture();
        native.messagePrivateAdmission.mockResolvedValueOnce({ ...projection(), [key]: OTHER });
        expect(await source.readAdmission()).toEqual(CLOSED);
    });
    it.each(['accountId', 'deviceId', 'credentialBinding'])(
        'rechecks changed native %s after the projection',
        async (key) => {
            const { native, source } = fixture();
            native.currentAccount
                .mockResolvedValueOnce(current())
                .mockResolvedValueOnce({ status: 'authenticated', account: { ...current().account, [key]: OTHER } });
            expect(await source.readAdmission()).toEqual(CLOSED);
        },
    );
    it.each([
        null,
        {},
        { status: 'authenticated', account: { ...current().account, serverVerified: false } },
        { status: 'authenticated', account: { ...current().account, credentialBinding: BINDING + '\n' } },
        {
            status: 'authenticated',
            account: { ...current().account, deviceId: '00000000-0000-0000-0000-000000000000' },
        },
    ])('refuses malformed initial native owner', async (value) => {
        const { native, source } = fixture();
        native.currentAccount.mockResolvedValueOnce(value);
        expect(await source.readAdmission()).toEqual(CLOSED);
        expect(native.messagePrivateAdmission).not.toHaveBeenCalled();
    });
    it('rejects extra contents and accessors without evaluating getters', async () => {
        const { native, source } = fixture();
        let reads = 0;
        const value = projection();
        Object.defineProperty(value, 'selection', {
            enumerable: true,
            get() {
                reads++;
                return 'protected-required';
            },
        });
        native.messagePrivateAdmission.mockResolvedValueOnce(value);
        expect(await source.readAdmission()).toEqual(CLOSED);
        expect(reads).toBe(0);
        native.messagePrivateAdmission.mockResolvedValueOnce({ ...projection(), token: 'synthetic' });
        expect(await source.readAdmission()).toEqual(CLOSED);
    });
    it('captures scalars before a delayed recheck and returns a frozen nonalias result', async () => {
        const { native, source } = fixture();
        const value = projection();
        const gate = deferred<unknown>();
        native.messagePrivateAdmission.mockResolvedValueOnce(value);
        native.currentAccount.mockResolvedValueOnce(current()).mockReturnValueOnce(gate.promise);
        const result = source.readAdmission();
        await Promise.resolve();
        await Promise.resolve();
        value.selection = 'legacy-permitted';
        value.accountId = OTHER;
        gate.resolve(current());
        const actual = await result;
        expect(actual).toEqual(projection());
        expect(actual).not.toBe(value);
        expect(Object.isFrozen(actual)).toBe(true);
    });
    it('invalidation suppresses a late native projection without issuing a native logout', async () => {
        const { native, source } = fixture();
        const gate = deferred<unknown>();
        native.messagePrivateAdmission.mockReturnValueOnce(gate.promise);
        const first = source.readAdmission();
        await Promise.resolve();
        source.invalidate();
        gate.resolve(projection());
        expect(await first).toEqual(CLOSED);
        expect(native.currentAccount).toHaveBeenCalledTimes(1);
    });
    it('bounds overlapping reads until original work settles, without reviving an old epoch', async () => {
        const { native, source } = fixture();
        const gate = deferred<unknown>();
        native.currentAccount.mockReturnValueOnce(gate.promise);
        const first = source.readAdmission();
        expect(await source.readAdmission()).toEqual(CLOSED);
        expect(native.currentAccount).toHaveBeenCalledTimes(1);
        gate.resolve(current());
        expect(await first).toEqual(CLOSED);
        expect(native.messagePrivateAdmission).not.toHaveBeenCalled();
        expect(await source.readAdmission()).toEqual(projection());
    });
    it.each(['currentAccount', 'messagePrivateAdmission'] as const)('suppresses raw %s failures', async (method) => {
        const { native, source } = fixture();
        native[method].mockRejectedValueOnce(new Error('synthetic opaque failure'));
        expect(await source.readAdmission()).toEqual(CLOSED);
    });
});
