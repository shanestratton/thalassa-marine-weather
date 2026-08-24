/**
 * MemoryGauge native contract — the tripwires that keep the jetsam brake real.
 *
 * The failure mode is the Barometer one: an app-local Capacitor plugin that
 * is not in the pbxproj build graph, or not registered on the bridge, just
 * answers "not implemented on ios" — and the ENC merge brake silently
 * reverts to the no-op that let the WKWebView die at Lady Musgrave
 * (2026-08-21). Nothing would crash and nothing would say why.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const nativePlugin = read('ios/App/App/MemoryGaugePlugin.swift');
const objcBridge = read('ios/App/App/MemoryGaugePlugin.m');
const bridge = read('ios/App/App/ThalassaBridgeViewController.swift');
const xcodeProject = read('ios/App/App.xcodeproj/project.pbxproj');
const service = read('services/native/memoryGauge.ts');
const gauge = read('utils/heapGauge.ts');
const hazard = read('services/enc/EncHazardService.ts');

describe('native MemoryGauge plugin contract', () => {
    it('reads allocatable memory from the OS, in MB', () => {
        expect(nativePlugin).toContain('os_proc_available_memory()');
        expect(nativePlugin).toContain('availableMB');
        expect(nativePlugin).toContain('/ 1_048_576');
    });

    it('forwards system memory warnings and detaches on deinit', () => {
        expect(nativePlugin).toContain('didReceiveMemoryWarningNotification');
        expect(nativePlugin).toContain('notifyListeners("warning"');
        expect(nativePlugin).toContain('deinit');
        expect(nativePlugin).toContain('removeObserver');
    });

    it('is bridged, compiled, and manually registered', () => {
        expect(objcBridge).toContain('CAP_PLUGIN(MemoryGaugePlugin, "MemoryGauge"');
        expect(objcBridge).toContain('CAP_PLUGIN_METHOD(read, CAPPluginReturnPromise)');
        expect(objcBridge).toContain('CAP_PLUGIN_METHOD(addListener, CAPPluginReturnCallback)');
        expect(bridge).toContain('registerPluginInstance(MemoryGaugePlugin())');
        expect(xcodeProject).toMatch(/MemoryGaugePlugin\.swift in Sources/);
        expect(xcodeProject).toMatch(/MemoryGaugePlugin\.m in Sources/);
    });
});

describe('the brake is wired to the gauge', () => {
    it('awaitHeapHeadroom has a WKWebView branch that consults the native gauge', () => {
        expect(gauge).toContain('refreshAvailableMemory');
        expect(gauge).toContain('NATIVE_AVAILABLE_FLOOR_MB');
    });

    it('crumbs can carry the available-memory tag where the heap tag is blind', () => {
        expect(gauge).toContain('recentAvailableMemory');
        expect(gauge).toMatch(/,a\$\{/);
    });

    it('the merge pipeline still calls the brake before every heavy build', () => {
        expect(hazard).toContain('await awaitHeapHeadroom();');
    });

    it('the gauge never idles: readings are on-demand only', () => {
        // A background poll would burn battery for a number nobody is
        // reading. The brake refreshes when it is about to build.
        expect(service).not.toContain('setInterval');
    });
});

describe('supersede-at-enqueue (the merge-stack killer)', () => {
    it('the newest-generation slot is claimed when a merge QUEUES, not when it runs', () => {
        // The queue serializes merges; claiming inside the job made queued
        // stale merges unsupersedable, so a stepped zoom across the bucket
        // edges ran 3-4 full builds back-to-back — the jetsam transient.
        const enqueueAt = hazard.indexOf('const enqueueGen = zoom != null ? claimMergeGen() : null;');
        const queueAt = hazard.indexOf('const build = mergeBuildQueue(');
        expect(enqueueAt).toBeGreaterThan(-1);
        expect(queueAt).toBeGreaterThan(-1);
        expect(enqueueAt).toBeLessThan(queueAt);
        expect(hazard).toContain('buildMergedVectorData(cells, cacheKey, densify, buildGlaze, zoom, enqueueGen)');
    });
});
