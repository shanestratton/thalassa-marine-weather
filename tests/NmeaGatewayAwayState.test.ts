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

    it('the Vessel hub row reads the shared boat link: Aboard or Away by position, never by lane', () => {
        const hub = read('components/VesselHub.tsx');
        // The state rides in the row's right-hand slot, as the Settings rows
        // show theirs, and the subtitle names the route (UX scorecard run 10).
        // Since 2026-10-07 both come from services/boatLink, which decides
        // where the phone is by position: "Aboard" whenever the Pi answered
        // directly was false over a VPN that carries the boat's network.
        expect(hub).toContain('const boatLink = useBoatLink();');
        expect(hub).toContain('const gatewayStatus = boatLink.hub.status;');
        expect(hub).toContain('const gatewayState = boatLink.hub.value;');
        expect(hub).not.toMatch(/remote\?\.via === 'lan'/);
        // Shane 2026-09-07: "calypso is not the boat name. it is the internal pi
        // name" — the hostname never reaches a user-facing string.
        expect(hub).not.toContain('reading her via ${');
        expect(hub).toContain('status={gatewayStatus}');
        expect(hub).toContain('value={gatewayState}');
    });

    it('the gateway page says where and how fresh in one pill, from the shared boat link', () => {
        const page = read('components/vessel/NmeaPage.tsx');
        expect(page).toContain('const link = useBoatLink();');
        expect(page).toContain('status={<BoatLinkPill pill={link.pill}');
        expect(page).not.toContain('Away · via the Pi');
        expect(page).not.toContain('Aboard · via the Pi');
        expect(page).not.toMatch(/remote\?\.via === 'lan'/);
    });
});
