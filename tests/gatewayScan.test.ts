import { describe, it, expect, vi } from 'vitest';
import {
    looksLikeNmea,
    looksLikeHttp,
    subnetPrefixOf,
    isPrivateIpv4,
    scanForGateways,
    discoverGateways,
    SCAN_PORTS,
    detectSubnetByRouterProbe,
    COMMON_SUBNET_PREFIXES,
    type ScanProbe,
} from '../services/nmea/gatewayScan';

/**
 * Finding the boat's NMEA gateway by scanning the LAN (Shane, back from
 * Tangalooma 2026-08-02: sailed without instruments because the YDWG-02's IP
 * had been forgotten).
 *
 * The load-bearing judgement is WHAT TO OFFER. An open port proves nothing —
 * routers, printers and the Pi all answer — so a candidate is only "confirmed"
 * once its bytes look like marine data. Offering the wrong host is worse than
 * offering none: the skipper saves it and then wonders why no instruments
 * appear.
 */

/** Build a probe from a map of "host:port" → bytes the device would send. */
const probeFrom = (listeners: Record<string, string>): ScanProbe => {
    return vi.fn(async (host: string, port: number) => {
        const key = `${host}:${port}`;
        if (!(key in listeners)) return { open: false };
        return { open: true, sample: listeners[key] };
    });
};

const YDWG_RAW = '16:29:27.082 R 09F8017F 50 C3 B8 13 47 D8 2B C6\n16:29:27.104 R 09F8027F 00 2F 30 76 41 9F C6 0C';
const NMEA_0183 = '$GPRMC,062725.00,A,2712.4998,S,15305.2500,E,5.4,182.1,020826,11.5,E*7A\r\n';
const AIS = '!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C\r\n';

describe('looksLikeNmea — what earns a "confirmed"', () => {
    it('recognises the three shapes this app parses', () => {
        expect(looksLikeNmea(NMEA_0183)).toBe(true);
        expect(looksLikeNmea(AIS)).toBe(true);
        expect(looksLikeNmea(YDWG_RAW)).toBe(true);
        expect(looksLikeNmea('$PCDIN,01F119,00000000,0F,FFFF7FFF*21')).toBe(true);
        expect(looksLikeNmea('A173321.107 23FF7 1F513 012F3070')).toBe(true);
    });

    it('is not fooled by things that merely contain a dollar sign', () => {
        expect(looksLikeNmea('')).toBe(false);
        expect(looksLikeNmea('$ ')).toBe(false);
        expect(looksLikeNmea('user@boat:~$ ls')).toBe(false);
        expect(looksLikeNmea('{"price":"$42","ok":true}')).toBe(false);
        expect(looksLikeNmea('SSH-2.0-OpenSSH_9.6')).toBe(false);
        // Right shape, wrong length — must not match a 2-letter sentence id.
        expect(looksLikeNmea('$GPRM,123')).toBe(false);
    });

    it('rejects a web server outright', () => {
        expect(looksLikeHttp('HTTP/1.1 200 OK\r\nContent-Type: text/html')).toBe(true);
        expect(looksLikeHttp('<!DOCTYPE html><html>')).toBe(true);
        expect(looksLikeHttp(NMEA_0183)).toBe(false);
    });
});

describe('subnet helpers', () => {
    it('extracts the /24 prefix', () => {
        expect(subnetPrefixOf('192.168.50.159')).toBe('192.168.50.');
        expect(subnetPrefixOf('10.0.0.4')).toBe('10.0.0.');
    });

    it('rejects malformed and out-of-range addresses', () => {
        expect(subnetPrefixOf('not-an-ip')).toBeNull();
        expect(subnetPrefixOf('192.168.1')).toBeNull();
        expect(subnetPrefixOf('999.1.1.1')).toBeNull();
    });

    it('knows a boat LAN from a public address', () => {
        expect(isPrivateIpv4('192.168.1.10')).toBe(true);
        expect(isPrivateIpv4('10.5.5.5')).toBe(true);
        expect(isPrivateIpv4('172.20.10.3')).toBe(true); // iPhone hotspot
        expect(isPrivateIpv4('172.32.0.1')).toBe(false); // just outside the block
        expect(isPrivateIpv4('8.8.8.8')).toBe(false);
    });
});

describe('scanForGateways', () => {
    it('finds a factory YDWG-02 and marks it confirmed', async () => {
        const probe = probeFrom({ '192.168.1.151:1456': YDWG_RAW });
        const found = await scanForGateways({ subnetPrefix: '192.168.1.', probe });

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
            host: '192.168.1.151',
            port: 1456,
            profileId: 'ydwg02',
            confidence: 'confirmed',
        });
    });

    it('never offers a router web UI as a gateway', async () => {
        const probe = probeFrom({
            '192.168.1.1:80': 'HTTP/1.1 200 OK\r\n\r\n<html>router</html>',
            '192.168.1.1:3000': '<!DOCTYPE html><html>admin</html>',
        });
        const found = await scanForGateways({ subnetPrefix: '192.168.1.', probe });
        expect(found).toEqual([]);
    });

    it('offers a silent listener as LIKELY, not confirmed — some gateways wait for bus traffic', async () => {
        const probe = probeFrom({ '192.168.1.77:1456': '' });
        const found = await scanForGateways({ subnetPrefix: '192.168.1.', probe });

        expect(found).toHaveLength(1);
        expect(found[0].confidence).toBe('likely');
    });

    it('ranks confirmed above likely so the real gateway is the first tap', async () => {
        const probe = probeFrom({
            '192.168.1.20:1456': '', // silent
            '192.168.1.99:10110': NMEA_0183, // real data
        });
        const found = await scanForGateways({ subnetPrefix: '192.168.1.', probe });

        expect(found.map((c) => c.host)).toEqual(['192.168.1.99', '192.168.1.20']);
    });

    it('tries the DEFAULT port across every host before any other port', async () => {
        const order: number[] = [];
        const probe: ScanProbe = vi.fn(async (_host, port) => {
            if (!order.includes(port)) order.push(port);
            return { open: false };
        });
        await scanForGateways({ subnetPrefix: '192.168.1.', probe, concurrency: 4 });

        expect(order[0]).toBe(1456); // Shane: "start with the default port"
        expect(order).toEqual(SCAN_PORTS.map((p) => p.port));
    });

    it('stops promptly when the skipper cancels', async () => {
        let calls = 0;
        const probe: ScanProbe = vi.fn(async () => {
            calls++;
            return { open: false };
        });
        await scanForGateways({
            subnetPrefix: '192.168.1.',
            probe,
            concurrency: 2,
            shouldStop: () => calls >= 10,
        });
        expect(calls).toBeLessThan(254 * SCAN_PORTS.length);
    });

    it('a probe that throws is a closed port, not a failed scan', async () => {
        const probe: ScanProbe = vi.fn(async (host, port) => {
            if (host === '192.168.1.5') throw new Error('EHOSTUNREACH');
            if (host === '192.168.1.151' && port === 1456) return { open: true, sample: YDWG_RAW };
            return { open: false };
        });
        const found = await scanForGateways({ subnetPrefix: '192.168.1.', probe });
        expect(found.map((c) => c.host)).toEqual(['192.168.1.151']);
    });
});

describe('discoverGateways — phased hunt', () => {
    it('stops after phase 1 when the default port confirms — no wasted sweeps', async () => {
        const ports = new Set<number>();
        const probe: ScanProbe = vi.fn(async (host, port) => {
            ports.add(port);
            if (host === '192.168.1.151' && port === 1456) return { open: true, sample: YDWG_RAW };
            return { open: false };
        });
        const phases: string[] = [];
        const found = await discoverGateways({ subnetPrefix: '192.168.1.', probe, onPhase: (p) => phases.push(p) });

        expect(found[0].host).toBe('192.168.1.151');
        expect(phases).toEqual(['default-ports']); // never needed to go deeper
        expect(ports.has(80)).toBe(false); // liveness sweep never ran
    });

    it('finds a gateway MOVED to a non-standard port, via its web-config address', async () => {
        // The YDWG's data port was reconfigured to 5001 — invisible to phase 1
        // — but its setup page still answers on 80, which is what makes the
        // deep sweep cheap enough to run at all.
        const probe = probeFrom({
            '192.168.1.151:80': 'HTTP/1.1 200 OK\r\n\r\n<html>YDWG setup</html>',
            '192.168.1.151:5001': YDWG_RAW,
        });
        const phases: string[] = [];
        const found = await discoverGateways({ subnetPrefix: '192.168.1.', probe, onPhase: (p) => phases.push(p) });

        expect(phases).toEqual(['default-ports', 'finding-devices', 'deep-ports']);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ host: '192.168.1.151', port: 5001, confidence: 'confirmed' });
    });

    it('deep-sweeps only hosts proven alive, not the whole subnet', async () => {
        const deepTargets = new Set<string>();
        const probe: ScanProbe = vi.fn(async (host, port) => {
            if (port === 80)
                return host === '192.168.1.151' ? { open: true, sample: '<html>x</html>' } : { open: false };
            if (port === 5001) deepTargets.add(host);
            return { open: false };
        });
        await discoverGateways({ subnetPrefix: '192.168.1.', probe });

        expect([...deepTargets]).toEqual(['192.168.1.151']);
    });
});

describe('detectSubnetByRouterProbe — find the network, do not ask for it', () => {
    it('identifies the subnet from a router at .1', async () => {
        const probe = probeFrom({ '192.168.50.1:80': '<html>router</html>' });
        expect(await detectSubnetByRouterProbe(probe)).toBe('192.168.50.');
    });

    it('finds a router at .254 too', async () => {
        const probe = probeFrom({ '10.0.0.254:443': '' });
        expect(await detectSubnetByRouterProbe(probe)).toBe('10.0.0.');
    });

    it('finds a router that only answers DNS — no web UI needed', async () => {
        const probe = probeFrom({ '192.168.8.1:53': '' });
        expect(await detectSubnetByRouterProbe(probe)).toBe('192.168.8.');
    });

    it('returns null rather than guessing when nothing answers', async () => {
        expect(await detectSubnetByRouterProbe(probeFrom({}))).toBeNull();
    });

    it('prefers the earlier candidate when two networks would both answer', async () => {
        // Ordering is the whole contract: the common ranges are tried first so
        // the usual case costs one round-trip.
        const probe = probeFrom({ '192.168.1.1:80': '', '192.168.50.1:80': '' });
        expect(await detectSubnetByRouterProbe(probe)).toBe('192.168.1.');
        expect(COMMON_SUBNET_PREFIXES.indexOf('192.168.1.')).toBeLessThan(
            COMMON_SUBNET_PREFIXES.indexOf('192.168.50.'),
        );
    });

    it('stops when cancelled mid-hunt', async () => {
        let calls = 0;
        const probe: ScanProbe = vi.fn(async () => {
            calls++;
            return { open: false };
        });
        await detectSubnetByRouterProbe(probe, { shouldStop: () => calls >= 6 });
        expect(calls).toBeLessThan(COMMON_SUBNET_PREFIXES.length * 6);
    });

    it("covers Shane's own network layout — router .1, boat kit high in the range", async () => {
        // His LAN as actually observed: gateway at 192.168.50.1, Pi at .150.
        const probe = probeFrom({ '192.168.50.1:80': '<html/>', '192.168.50.150:10110': NMEA_0183 });
        const prefix = await detectSubnetByRouterProbe(probe);
        expect(prefix).toBe('192.168.50.');
        const found = await scanForGateways({ subnetPrefix: prefix as string, probe });
        expect(found[0]).toMatchObject({ host: '192.168.50.150', port: 10110, confidence: 'confirmed' });
    });
});
