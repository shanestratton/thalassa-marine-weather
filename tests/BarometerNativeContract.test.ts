import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The barometer's failure mode is silence: an app-local Capacitor plugin that
 * isn't in the pbxproj build graph, or isn't registered in the bridge, just
 * returns "not implemented on ios" and the panel quietly falls back to
 * forecast pressure forever. Nothing crashes and nothing says why. These
 * assertions are the tripwire for that.
 */
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const nativePlugin = read('ios/App/App/BarometerPlugin.swift');
const objcBridge = read('ios/App/App/BarometerPlugin.m');
const bridge = read('ios/App/App/ThalassaBridgeViewController.swift');
const xcodeProject = read('ios/App/App.xcodeproj/project.pbxproj');
const infoPlist = read('ios/App/App/Info.plist');
const service = read('services/native/barometer.ts');
const panel = read('components/dashboard/hero/BarometerPlus.tsx');
const grid = read('components/dashboard/HeroWidgets.tsx');
const glassLayout = read('components/dashboard/glassLayout.ts');

describe('native Barometer plugin contract', () => {
    it('reads CoreMotion and converts kPa to hPa exactly once', () => {
        expect(nativePlugin).toContain('import CoreMotion');
        expect(nativePlugin).toContain('CMAltimeter.isRelativeAltitudeAvailable()');
        expect(nativePlugin).toContain('startRelativeAltitudeUpdates');
        // CMAltitudeData.pressure is kPa; the app works in hPa.
        expect(nativePlugin).toContain('data.pressure.doubleValue * 10.0');
    });

    it('emits a median per window, not a raw reading, and floors the interval', () => {
        expect(nativePlugin).toContain('let sorted = window.sorted()');
        expect(nativePlugin).toContain('intervalMs = max(1_000, requested)');
        expect(nativePlugin).toContain('notifyListeners("sample"');
    });

    it('rejects impossible readings rather than logging them as weather', () => {
        expect(nativePlugin).toContain('hpa.isFinite, hpa > 300, hpa < 1200');
    });

    it('reports hardware and authorization separately so the UI can explain itself', () => {
        expect(nativePlugin).toContain('CMAltimeter.authorizationStatus()');
        expect(nativePlugin).toContain('"authorization": authorization');
        expect(service).toContain("reason: 'no-hardware'");
        expect(service).toContain("reason: 'denied'");
    });

    it('stops CoreMotion when the plugin goes away', () => {
        expect(nativePlugin).toContain('deinit');
        expect(nativePlugin).toContain('stopRelativeAltitudeUpdates()');
    });

    it('is bridged, compiled, and manually registered', () => {
        expect(objcBridge).toContain('CAP_PLUGIN(BarometerPlugin, "Barometer"');
        expect(objcBridge).toContain('CAP_PLUGIN_METHOD(addListener, CAPPluginReturnCallback)');
        expect(bridge).toContain('registerPluginInstance(BarometerPlugin())');
        expect(xcodeProject).toMatch(/BarometerPlugin\.swift in Sources/);
        expect(xcodeProject).toMatch(/BarometerPlugin\.m in Sources/);
        expect(service).toContain("registerPlugin<BarometerPlugin>('Barometer')");
    });

    it('declares the motion permission the barometer actually needs', () => {
        expect(infoPlist).toContain('NSMotionUsageDescription');
        // CoreMotion prompts with this string; it must mention the barometer,
        // not only the anchor-watch motion detection it was written for.
        const idx = infoPlist.indexOf('NSMotionUsageDescription');
        expect(infoPlist.slice(idx, idx + 400).toLowerCase()).toContain('barometer');
    });
});

describe('BarometerPlus panel contract', () => {
    it('applies the calibration offset at read time, never to the stored record', () => {
        expect(service).toContain('hpa: hpa + off');
        // calibrateTo must not rewrite state.samples.
        const calibrate = service.slice(
            service.indexOf('export function calibrateTo'),
            service.indexOf('export function clearCalibration'),
        );
        expect(calibrate).not.toMatch(/state\.samples\s*=/);
        expect(calibrate).toContain('Math.abs(offset) > 60');
    });

    it('takes the tendency from raw station samples so calibration cannot move it', () => {
        expect(panel).toContain('observedTendency(stationSamples, nowT)');
    });

    it('opens in place from the HPA cell instead of the shared metric sheet', () => {
        expect(grid).toContain("if (id === 'pressure') {");
        expect(grid).toContain('setShowBarometer(true)');
        expect(grid).toContain('<BarometerPlus');
        // The overlay needs a positioned ancestor, or it escapes the card.
        expect(grid).toContain('relative w-full rounded-xl overflow-hidden');
    });

    it('fills the grid box without changing the card height the Glass stack depends on', () => {
        expect(glassLayout).toContain('GLASS_HERO_WIDGETS_OUTER_HEIGHT_PX = 163');
        expect(panel).toContain('absolute inset-0');
        // A scroll container anywhere but the explainer would mean the panel
        // outgrew its box.
        expect(panel.match(/overflow-y-auto/g)?.length ?? 0).toBe(1);
    });

    it('closes when the user scrolls off the live NOW card', () => {
        expect(grid).toContain('if (!isLive) setShowBarometer(false);');
    });
});
