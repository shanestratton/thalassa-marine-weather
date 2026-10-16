import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
    owner: 'owner',
    generation: 1,
    revision: 1,
    pair: {
        deviceId: 'pi',
        publicKeySpki: 'generated-pin',
        pairedAt: 'generated',
        boatName: 'Synthetic boat Pi',
    } as Record<string, string> | null,
    enrolled: 'phone' as string | null,
    getDevice: vi.fn(),
    read: vi.fn(),
    pictureCurrent: true,
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ userId: f.owner, generation: f.generation }),
    isAuthIdentityScopeCurrent: (s: { userId: string; generation: number }) =>
        s.userId === f.owner && s.generation === f.generation,
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => f.pair,
    getPiEquipmentReadRevision: () => f.revision,
    getChartDevice: () => f.getDevice(),
}));
vi.mock('../services/radar/piRadar', () => ({
    loadPiRadarPicture: f.read,
    PiRadarError: class extends Error {
        constructor(readonly code: string) {
            super(code);
        }
    },
}));
import { checkPairedRadarEquipment } from '../services/radar/radarEquipmentRead';
const T = Date.UTC(2026, 9, 17);
function picture() {
    return {
        configured: true,
        connected: true,
        overloaded: false,
        lastFrameAt: T - 1000,
        contacts: [{ talker: 'RA', scanner: 'Quantum 2', sentence: '$RATTM,fictional' }],
        model: 'fictional-injected-model',
        isCurrent: () => f.pictureCurrent,
    };
}
function options() {
    return { signal: new AbortController().signal, isCurrent: () => true };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    f.owner = 'owner';
    f.generation = 1;
    f.revision = 1;
    f.pair = { deviceId: 'pi', publicKeySpki: 'generated-pin', pairedAt: 'generated', boatName: 'Synthetic boat Pi' };
    f.enrolled = 'phone';
    f.pictureCurrent = true;
    f.getDevice.mockReset();
    f.read.mockReset();
    f.getDevice.mockImplementation(async () => (f.enrolled ? { chartDeviceId: f.enrolled } : null));
    f.read.mockResolvedValue(picture());
});
afterEach(() => vi.useRealTimers());
it('does one explicit cache read, retains original frame time, and never infers a scanner model or vessel', async () => {
    const result = await checkPairedRadarEquipment(options());
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
        source: 'paired-pi-target-feed',
        model: null,
        piName: 'Synthetic boat Pi',
        lastFrameAt: T - 1000,
        checkedAt: T,
    });
    expect(Object.keys(result)).not.toContain('contacts');
    expect(Object.keys(result)).not.toContain('boatId');
    expect(result.isCurrent()).toBe(true);
    f.revision++;
    expect(result.isCurrent()).toBe(false);
});
it.each(['owner', 'pair', 'enrollment'] as const)('does not read without %s', async (missing) => {
    if (missing === 'owner') f.owner = '';
    if (missing === 'pair') f.pair = null;
    if (missing === 'enrollment') f.enrolled = null;
    await expect(checkPairedRadarEquipment(options())).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.read).not.toHaveBeenCalled();
});
it.each(['account', 'pin', 'repair', 'reenroll', 'device', 'vessel', 'picture'] as const)(
    'rejects a late cache result after %s changes',
    async (what) => {
        let resolve!: (v: unknown) => void;
        f.read.mockImplementation(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        let current = true;
        const pending = checkPairedRadarEquipment({ ...options(), isCurrent: () => current });
        await vi.advanceTimersByTimeAsync(0);
        if (what === 'account') f.generation++;
        if (what === 'pin') f.pair = { ...f.pair!, publicKeySpki: 'changed' };
        if (what === 'repair' || what === 'reenroll') f.revision++;
        if (what === 'device') f.enrolled = 'other-phone';
        if (what === 'vessel') current = false;
        if (what === 'picture') f.pictureCurrent = false;
        resolve(picture());
        await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    },
);
it('cancels during local enrollment loading and bounds the entire check to six seconds', async () => {
    f.getDevice.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const first = checkPairedRadarEquipment({ signal: controller.signal, isCurrent: () => true });
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    const second = checkPairedRadarEquipment(options());
    const assertion = expect(second).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    expect(f.read).not.toHaveBeenCalled();
});
it('keeps disconnected and unknown-frame evidence, without claiming absent radar hardware', async () => {
    f.read.mockResolvedValue({ ...picture(), configured: false, connected: false, lastFrameAt: null });
    expect(await checkPairedRadarEquipment(options())).toMatchObject({
        model: null,
        configured: false,
        connected: false,
        lastFrameAt: null,
    });
});
