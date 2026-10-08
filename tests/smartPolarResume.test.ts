/**
 * Smart Polars keep learning after a restart (build 125, package 125-08; gap
 * register #12a learned-polars).
 *
 * The switch in Settings → Preferences started the learner, and nothing ever
 * started it again: every launch quietly stopped the learning until the
 * skipper toggled it off and on. Now the app's boot resumes it when the
 * switch is on (after the device's own settings have loaded), and never when
 * it is off. Resuming starts the learner only: which socket the instruments
 * come through stays InstrumentSourcePolicy's call (no gateway opened ashore).
 *
 * And the learner loads its grid with ensureLoaded, never initialize(), so a
 * second start (or the Polars page's refresh) cannot reload the disk copy
 * over samples recorded but not yet saved.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
    state: { settings: {} as Record<string, unknown> },
    loaded: Promise.resolve() as Promise<void>,
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => settings.state },
    awaitSettingsLoaded: () => settings.loaded,
}));

const nmea = vi.hoisted(() => ({
    listeners: new Set<(s: unknown) => void>(),
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        onSample: (cb: (s: unknown) => void) => {
            nmea.listeners.add(cb);
            return () => nmea.listeners.delete(cb);
        },
    },
}));
const storage = vi.hoisted(() => ({
    loadLargeData: vi.fn(async (): Promise<unknown> => null),
    saveLargeData: vi.fn(async () => undefined),
}));
vi.mock('../services/nativeStorage', () => ({
    loadLargeData: storage.loadLargeData,
    saveLargeData: storage.saveLargeData,
}));

beforeEach(() => {
    vi.resetModules();
    nmea.listeners.clear();
    storage.loadLargeData.mockReset();
    storage.loadLargeData.mockResolvedValue(null);
    settings.state = { settings: {} };
    settings.loaded = Promise.resolve();
});

describe('Smart Polars resume at launch', () => {
    it('resumes the learner when the switch is on', async () => {
        settings.state = { settings: { smartPolarsEnabled: true } };
        const { resumeSmartPolarsAtLaunch } = await import('../services/smartPolarResume');
        expect(await resumeSmartPolarsAtLaunch()).toBe(true);
        const { SmartPolarService } = await import('../services/SmartPolarService');
        expect(nmea.listeners.size).toBe(1);
        expect(SmartPolarService.getStatus().recording).toBe(false);
    });

    it('does nothing when the switch is off, or was never set', async () => {
        for (const value of [false, undefined]) {
            vi.resetModules();
            nmea.listeners.clear();
            settings.state = { settings: { smartPolarsEnabled: value } };
            const { resumeSmartPolarsAtLaunch } = await import('../services/smartPolarResume');
            expect(await resumeSmartPolarsAtLaunch()).toBe(false);
            expect(nmea.listeners.size).toBe(0);
            expect(storage.loadLargeData).not.toHaveBeenCalled();
        }
    });

    it("reads the switch only once this device's settings have loaded (not the defaults painted first)", async () => {
        let finishLoad!: () => void;
        settings.loaded = new Promise<void>((done) => (finishLoad = done));
        const { resumeSmartPolarsAtLaunch } = await import('../services/smartPolarResume');
        const resumed = resumeSmartPolarsAtLaunch();
        // The disk copy lands with the switch on.
        settings.state = { settings: { smartPolarsEnabled: true } };
        finishLoad();
        expect(await resumed).toBe(true);
        expect(nmea.listeners.size).toBe(1);
    });

    it('is what the app boot runs', () => {
        const boot = readFileSync(resolve(process.cwd(), 'hooks/useAppBootstrap.ts'), 'utf8');
        expect(boot).toContain("import('../services/smartPolarResume')");
        expect(boot).toContain('resumeSmartPolarsAtLaunch()');
    });
});

describe('the learner never reloads its grid over live samples', () => {
    it('start() loads with ensureLoaded, so a second start keeps samples not yet saved', async () => {
        const { SmartPolarStore } = await import('../services/SmartPolarStore');
        const { SmartPolarService } = await import('../services/SmartPolarService');
        const initialize = vi.spyOn(SmartPolarStore, 'initialize');
        await SmartPolarService.start();
        SmartPolarStore.recordSample(12, 90, 6.2);
        SmartPolarService.stop();
        await SmartPolarService.start();
        expect(SmartPolarStore.getStats().totalSamples).toBe(1);
        expect(storage.loadLargeData).toHaveBeenCalledTimes(1);
        // ensureLoaded calls initialize() once, for the first read only.
        expect(initialize).toHaveBeenCalledTimes(1);
    });

    it('a stop() while the grid is still loading leaves nothing listening', async () => {
        let finish!: (v: unknown) => void;
        storage.loadLargeData.mockImplementation(() => new Promise((done) => (finish = done)));
        const { SmartPolarService } = await import('../services/SmartPolarService');
        const started = SmartPolarService.start();
        SmartPolarService.stop();
        finish(null);
        await started;
        expect(nmea.listeners.size).toBe(0);
    });

    it("the Polars page reads the live grid, never initialize() (it refreshed every 15 s, reloading over the learner's samples)", () => {
        const page = readFileSync(resolve(process.cwd(), 'components/settings/PolarManagerTab.tsx'), 'utf8');
        expect(page).not.toContain('SmartPolarStore.initialize()');
        expect(page).toContain('SmartPolarStore.ensureLoaded()');
    });
});
