/**
 * The gateway socket and the store that consumes it must start together.
 *
 * 2026-08-08 gave the socket persistence across app restarts. 2026-08-09
 * revealed the other half was missing: Shane's YDWG-02 reconnected on launch
 * and streamed happily into nothing, because NmeaStore was only ever started
 * by tapping Connect on the NMEA page. The instrument panel gates every tile
 * on the store's own connectionStatus, so it reported "No feed" over a healthy
 * connection — a blank screen with a working gateway behind it.
 *
 * Half a lifecycle is worse than none: without autoStart the skipper knew to
 * press Connect, and pressing Connect started both.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const bootstrap = readFileSync(resolve(process.cwd(), 'hooks/useAppBootstrap.ts'), 'utf8');
const listener = readFileSync(resolve(process.cwd(), 'services/NmeaListenerService.ts'), 'utf8');
const panel = readFileSync(resolve(process.cwd(), 'components/nmea/TheGlassPage.tsx'), 'utf8');

/** The boot effect that restores the saved gateway. */
const bootBlock = (() => {
    const start = bootstrap.indexOf("import('../services/NmeaListenerService')");
    expect(start, 'NMEA boot effect not found').toBeGreaterThan(-1);
    return bootstrap.slice(start, start + 900);
})();

describe('NMEA boot lifecycle', () => {
    it('starts the store as well as the socket', () => {
        expect(bootBlock).toMatch(/NmeaStore\.start\(\)/);
        expect(bootBlock).toMatch(/NmeaListenerService\.autoStart\(\)/);
    });

    it('starts the store BEFORE the socket, so it catches the first status', () => {
        // NmeaPage's Connect handler has always done this in the right order
        // and says why. Boot has to match, or the store subscribes after the
        // 'connecting' event it needed to see.
        const storeAt = bootBlock.indexOf('NmeaStore.start()');
        const socketAt = bootBlock.indexOf('NmeaListenerService.autoStart()');
        expect(storeAt).toBeGreaterThan(-1);
        expect(socketAt).toBeGreaterThan(-1);
        expect(storeAt).toBeLessThan(socketAt);
    });

    it('does neither when no gateway was ever configured', () => {
        // A punter with no gateway must not have AIS, the GPS bridge and a
        // 1 Hz watchdog started on their behalf.
        expect(bootBlock).toMatch(/if\s*\(!NmeaListenerService\.getSavedConfig\(\)\)\s*return;/);
    });
});

describe('getSavedConfig', () => {
    it('is the single place that knows the storage keys', () => {
        expect(listener).toMatch(/getSavedConfig\(\)\s*:\s*\{\s*host: string; port: number\s*\}\s*\|\s*null/);
        // Bootstrap asks the service rather than reading localStorage itself.
        expect(bootBlock).not.toMatch(/localStorage/);
    });

    it('lets autoStart report whether it actually did anything', () => {
        expect(listener).toMatch(/autoStart\(\): boolean/);
        expect(listener).toMatch(/if \(!config\) return false;/);
    });
});

describe('the panel does not depend on which page was visited first', () => {
    it('claims the store itself on mount', () => {
        // Every tile is gated on connectionStatus, so an unstarted store is a
        // completely blank panel over a live gateway. start() is idempotent.
        expect(panel).toMatch(/if \(NmeaListenerService\.getSavedConfig\(\)\) NmeaStore\.start\(\);/);
    });

    it('never stops the store on unmount', () => {
        // The store is a global singleton feeding alarms, the GPS bridge and
        // AIS. A page tearing it down on navigation would silently disarm
        // things the skipper never asked to stop.
        expect(panel).not.toMatch(/NmeaStore\.stop\(\)/);
    });

    it('explains a blank panel instead of merely being blank', () => {
        expect(panel).toMatch(/diagnosePanel\(/);
        expect(panel).toMatch(/diagnosis\.detail &&/);
    });
});
