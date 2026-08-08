import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Three small things that were each invisible in a different way.
 */
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const bootstrap = read('hooks/useAppBootstrap.ts');
const hub = read('components/VesselHub.tsx');
const musicSwift = read('ios/App/App/AppleMusicPlugin.swift');
const musicObjc = read('ios/App/App/AppleMusicPlugin.m');
const musicTs = read('services/voice/integrations/appleMusic.ts');
const musicPage = read('components/music/MusicPage.tsx');

describe('NMEA gateway reconnects on launch', () => {
    it('actually calls autoStart — it existed for months and nothing did', () => {
        expect(bootstrap).toContain('NmeaListenerService.autoStart()');
    });

    it('is not gated behind the Pi integration flag', () => {
        // That gate is about probing the boat LAN for a Pi. A gateway the
        // skipper configured by hand is a different thing, and hiding this
        // behind that flag would reintroduce the same silence.
        const block = bootstrap.slice(
            bootstrap.indexOf('NMEA gateway: reconnect on launch'),
            bootstrap.indexOf('GPS warm-up'),
        );
        // Match the GUARD, not the word: the comment in that block explains
        // why the flag is deliberately absent, so a bare substring check was
        // testing its own prose.
        expect(block).not.toMatch(/if\s*\(!PI_INTEGRATION_ENABLED\)/);
    });
});

describe('Music is reachable again', () => {
    it('has an entry point, not just a registered route', () => {
        expect(hub).toContain("onNavigate('music')");
        expect(hub).toContain('RESTORED 2026-08-08');
    });
});

describe('speaker routing', () => {
    it('reports the CURRENT route and defers choosing to the system picker', () => {
        expect(musicSwift).toContain('AVRoutePickerView');
        expect(musicSwift).toContain('currentRoute');
        expect(musicObjc).toContain('CAP_PLUGIN_METHOD(getAudioRoute');
        expect(musicObjc).toContain('CAP_PLUGIN_METHOD(showRoutePicker');
        expect(musicTs).toContain('export async function showRoutePicker');
    });

    it('never pretends to enumerate outputs — iOS has no such API', () => {
        // If this ever appears, someone has invented a list. There is no
        // availableOutputs on AVAudioSession; only the picker knows.
        // Property ACCESS, not the identifier — both files name
        // `availableOutputs` in comments precisely to record that it does not
        // exist, and matching that was testing the documentation.
        expect(musicSwift).not.toMatch(/\.availableOutputs\b/);
        expect(musicTs).not.toMatch(/\.availableOutputs\b/);
    });

    it('cleans up the hidden picker view instead of littering the window', () => {
        expect(musicSwift).toContain('picker.removeFromSuperview()');
    });

    it('falls back silently off iOS rather than throwing into the page', () => {
        expect(musicTs).toContain("if (Capacitor.getPlatform() !== 'ios') return null;");
        expect(musicPage).toContain('void showRoutePicker()');
    });
});
