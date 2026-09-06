/**
 * The NMEA Gateway card and page know when the boat is being read via the Pi.
 *
 * Shane 2026-09-07: "we will need to update the NMEA Gateway card since it will
 * not need to directly connect to the pi anymore". The socket is still the
 * best source aboard; away, the store is fed from the Pi's cloud snapshot and
 * these two surfaces must say so instead of reading as a fault.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('the gateway surfaces say how the boat is being read', () => {
    it('a connection-only hook exists so the Vessel hub does not re-render per sample', () => {
        const hook = read('components/nmea/useNmeaStore.tsx');
        expect(hook).toContain('export function useNmeaConnectionStatus()');
        expect(hook).toContain('prev.status === next.status &&');
    });

    it('the Vessel hub row reads Connected, Away via the Pi, or connect-when-aboard', () => {
        const hub = read('components/VesselHub.tsx');
        expect(hub).toContain("? 'Connected · instruments & AIS'");
        expect(hub).toContain("`Away · reading her via ${nmeaLink.remote?.deviceLabel ?? 'the Pi'}`");
        expect(hub).toContain("'Instruments & AIS · connect when aboard'");
        expect(hub).toContain('status={gatewayStatus}');
    });

    it('the gateway page shows an Away badge instead of a fault while the cloud feeds the panel', () => {
        const page = read('components/vessel/NmeaPage.tsx');
        expect(page).toContain("const readingViaCloud = storeLink.status === 'remote';");
        expect(page).toContain('Away · via {storeLink.remote?.deviceLabel ?? ');
        expect(page).toContain('readingViaCloud && !isConnected && !isConnecting');
    });
});
