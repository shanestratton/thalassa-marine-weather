import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const mocks = vi.hoisted(() => ({ bus: vi.fn(), pi: vi.fn(), cloud: vi.fn() }));
vi.mock('../services/boatPositionChain', () => ({ busFix: mocks.bus, piFix: mocks.pi }));
vi.mock('../services/CloudTelemetryService', () => ({ CloudTelemetryService: { readOnce: mocks.cloud } }));
import {
    plannerVesselLabel,
    readPlannerVesselPosition,
    validPlannerVesselFix,
} from '../services/plannerVesselPosition';
const fix = (age = 0) => ({ latitude: -20.2, longitude: 148.8, timestamp: Date.now() - age, rung: 'bus' as const });
const cloud = (age = 0) => ({ reportedAt: Date.now() - age, source: 'pi', snapshot: { lat: -20.2, lon: 148.8 } });
beforeEach(() => {
    vi.resetAllMocks();
    setAuthIdentityScope('owner');
    mocks.bus.mockReturnValue(null);
    mocks.pi.mockResolvedValue(null);
    mocks.cloud.mockResolvedValue(null);
});
describe('planner boat position (display only)', () => {
    it('prefers the fresh boat receiver without a cloud or device-GPS request', async () => {
        mocks.bus.mockReturnValue(fix());
        expect(await readPlannerVesselPosition()).toMatchObject({ rung: 'bus', latitude: -20.2 });
        expect(mocks.pi).not.toHaveBeenCalled();
        expect(mocks.cloud).not.toHaveBeenCalled();
    });
    it('uses the account boat cloud report on the web, never the saved home/weather location', async () => {
        mocks.bus.mockReturnValue(fix(60000));
        mocks.cloud.mockResolvedValue(cloud());
        expect(await readPlannerVesselPosition()).toMatchObject({ rung: 'cloud', latitude: -20.2, longitude: 148.8 });
    });
    it('labels last-known positions honestly and refuses implausible/very old data', async () => {
        mocks.cloud.mockResolvedValue(cloud(120000));
        const result = await readPlannerVesselPosition();
        expect(plannerVesselLabel(result!)).toContain('Last reported yacht position · 2 min ago');
        expect(validPlannerVesselFix(result, 60000)).toBe(false);
        mocks.cloud.mockResolvedValue(cloud(25 * 3600000));
        expect(await readPlannerVesselPosition()).toBeNull();
        expect(validPlannerVesselFix({ ...fix(), longitude: 181 }, 60000)).toBe(false);
        expect(validPlannerVesselFix({ ...fix(), timestamp: Date.now() + 10000 }, 60000)).toBe(false);
    });
    it('does not refresh an old position merely because instruments uploaded recently', async () => {
        const report = cloud();
        mocks.cloud.mockResolvedValue({
            ...report,
            snapshot: { ...report.snapshot, positionSampleAt: Date.now() - 300000 },
        });
        expect(plannerVesselLabel((await readPlannerVesselPosition())!)).toContain('5 min ago');
    });
    it('discards a cloud reply if the signed-in account changes', async () => {
        let resolve!: (value: unknown) => void;
        mocks.cloud.mockReturnValue(
            new Promise((r) => {
                resolve = r;
            }),
        );
        const reading = readPlannerVesselPosition();
        await vi.waitFor(() => expect(mocks.cloud).toHaveBeenCalled());
        setAuthIdentityScope('different');
        resolve(cloud());
        expect(await reading).toBeNull();
    });
});
