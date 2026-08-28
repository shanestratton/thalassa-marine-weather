/**
 * "One-time migration" was in the comment and nowhere in the code.
 *
 * It ran in the NmeaPage render body — every render, and twice on mount under
 * StrictMode — and it deleted any saved port of 10110 unconditionally. 10110
 * is not a stale default: it is the standard NMEA 0183 over TCP port, one this
 * app's own scanner offers and labels as such (gatewayScan SCAN_PORTS).
 *
 * So a deliberately-configured gateway on 10110 had its port silently removed
 * and replaced by the 1456 default while the HOST was left alone — a
 * half-migration producing a pairing the skipper never chose. On Shane's setup
 * that was the house Pi on the YDWG's own port: the one combination that makes
 * the app blame a Yacht Devices gateway for a Raspberry Pi in the spare room.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('components/vessel/NmeaPage.tsx', 'utf8');

describe('legacy gateway default migration', () => {
    it('is guarded by a persisted flag, not re-run every render', () => {
        expect(src).toContain("const LEGACY_DEFAULTS_CLEARED_KEY = 'nmea_legacy_defaults_cleared';");
        expect(src).toContain('if (localStorage.getItem(LEGACY_DEFAULTS_CLEARED_KEY)) return;');
        expect(src).toContain("localStorage.setItem(LEGACY_DEFAULTS_CLEARED_KEY, '1');");
    });

    it('also short-circuits within a session, so a re-render costs nothing', () => {
        expect(src).toContain('let legacyDefaultsCheckedThisSession = false;');
        expect(src).toContain('if (legacyDefaultsCheckedThisSession) return;');
    });

    it('no longer deletes a saved port of 10110 on sight', () => {
        // The exact line that did it.
        expect(src).not.toContain(
            "if (localStorage.getItem('nmea_port') === '10110') localStorage.removeItem('nmea_port');",
        );
    });

    it('only clears the old default HOST and PORT together, never one alone', () => {
        const fn = src.slice(
            src.indexOf('function clearLegacyGatewayDefaultsOnce'),
            src.indexOf('export const NmeaPage'),
        );
        // The condition is anchored on the legacy HOST; the port alone can
        // never trigger it.
        expect(fn).toContain('if (host === LEGACY_DEFAULT_HOST && (port === LEGACY_DEFAULT_PORT || port === null))');
        // And when it fires, both go.
        expect(fn).toContain("localStorage.removeItem('nmea_host');");
        expect(fn).toContain("localStorage.removeItem('nmea_port');");
        // No unconditional port removal survives anywhere in the function.
        const portRemovals = fn.split("localStorage.removeItem('nmea_port');").length - 1;
        expect(portRemovals).toBe(1);
    });

    it('survives storage being unavailable rather than taking the page down', () => {
        const fn = src.slice(
            src.indexOf('function clearLegacyGatewayDefaultsOnce'),
            src.indexOf('export const NmeaPage'),
        );
        expect(fn).toContain('} catch {');
    });
});

describe('the status FAB', () => {
    const fab = readFileSync('components/SystemStatusButton.tsx', 'utf8');

    it('shows the diagnosis instead of the flat "Not connected"', () => {
        // Every setStatus('error') writes a real sentence first; this panel
        // discarded all of them and rendered the same grey row as a gateway
        // the skipper had deliberately switched off.
        expect(fab).toContain('shortNmeaFault(NmeaListenerService.getLastError())');
        expect(fab).toContain("(fault ?? 'Not connected')");
    });

    it('drops the raw native tail, which does not belong in an 11px row', () => {
        expect(fab).toContain('SocketError');
        expect(fab).toContain('function shortNmeaFault');
    });

    it('distinguishes a fault from being switched off, by colour', () => {
        expect(fab).toContain("state.nmea.faulted ? 'bg-rose-400' : 'bg-slate-600'");
    });

    it('offers a way to the page that can fix it', () => {
        expect(fab).toContain("detail: { tab: 'nmea' }");
        expect(fab).toContain("label: 'Fix',");
    });
});
