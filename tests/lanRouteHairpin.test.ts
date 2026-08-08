/**
 * The VPN hairpin, as policy.
 *
 * Shane, on the boat 2026-08-08: the phone was on the boat's own Wi-Fi while
 * Tailscale advertised 192.168.1.0/24 from the RUTX50, so traffic to a gateway
 * two metres away went out over 5G, through the router's NAT, and back. It did
 * not fail cleanly — it was laggy and dropped connections, and read as broken
 * hardware. A day gone.
 *
 * An app cannot switch a system VPN off. It can notice. These tests pin WHEN
 * it should speak, and — just as important — when it must stay quiet, because
 * a banner that cries wolf on every VPN is a banner nobody reads.
 */
import { describe, expect, it } from 'vitest';
import { assessHairpin, sameIpv4Subnet, type NetworkInterfaceInfo } from '../utils/lanRoute';

const wifi = (address: string): NetworkInterfaceInfo => ({ name: 'en0', address, family: 'ipv4', tunnel: false });
const tunnel = (address = '100.76.191.7'): NetworkInterfaceInfo => ({
    name: 'utun3',
    address,
    family: 'ipv4',
    tunnel: true,
});
const cellular = (address: string): NetworkInterfaceInfo => ({
    name: 'pdp_ip0',
    address,
    family: 'ipv4',
    tunnel: false,
});

const GATEWAY = '192.168.1.151';

describe('sameIpv4Subnet', () => {
    it('matches a /24 and nothing wider', () => {
        expect(sameIpv4Subnet('192.168.1.7', '192.168.1.151')).toBe(true);
        expect(sameIpv4Subnet('192.168.2.7', '192.168.1.151')).toBe(false);
        expect(sameIpv4Subnet('10.0.0.7', '192.168.1.151')).toBe(false);
    });

    it('refuses malformed input rather than guessing', () => {
        expect(sameIpv4Subnet('192.168.1', '192.168.1.151')).toBe(false);
        expect(sameIpv4Subnet('not.an.ip.addr', '192.168.1.151')).toBe(false);
        expect(sameIpv4Subnet('192.168.1.999', '192.168.1.151')).toBe(false);
    });
});

describe('assessHairpin', () => {
    it('warns when aboard the gateway’s network with a tunnel up', () => {
        const result = assessHairpin({
            interfaces: [wifi('192.168.1.7'), tunnel()],
            hostIp: GATEWAY,
            hostLabel: 'the NMEA gateway',
        });
        expect(result.hairpinLikely).toBe(true);
        expect(result.localAddress).toBe('192.168.1.7');
        expect(result.warning).toContain('the NMEA gateway');
        expect(result.warning).toContain('192.168.1.7');
        expect(result.warning).toMatch(/Use Tailscale subnets/);
    });

    it('stays quiet on a VPN from ashore — that is the whole point of the VPN', () => {
        const result = assessHairpin({
            interfaces: [cellular('10.42.7.9'), tunnel()],
            hostIp: GATEWAY,
        });
        expect(result.vpnActive).toBe(true);
        expect(result.onSameLan).toBe(false);
        expect(result.hairpinLikely).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('stays quiet aboard with no VPN — the good case', () => {
        const result = assessHairpin({ interfaces: [wifi('192.168.1.7')], hostIp: GATEWAY });
        expect(result.onSameLan).toBe(true);
        expect(result.vpnActive).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('never treats the tunnel’s own address as being on the boat LAN', () => {
        // A tunnel handing out 192.168.1.x would otherwise look like proof we
        // are aboard, and the warning would fire from the far side of the
        // planet.
        const result = assessHairpin({
            interfaces: [cellular('10.42.7.9'), { ...tunnel('192.168.1.99') }],
            hostIp: GATEWAY,
        });
        expect(result.onSameLan).toBe(false);
        expect(result.warning).toBeNull();
    });

    it('says nothing when the host is unknown or nothing could be read', () => {
        expect(assessHairpin({ interfaces: [wifi('192.168.1.7'), tunnel()], hostIp: null }).warning).toBeNull();
        // Web build / probe failure — "we don't know" must never become a warning.
        expect(assessHairpin({ interfaces: [], hostIp: GATEWAY }).warning).toBeNull();
    });

    it('ignores IPv6 when deciding subnet membership', () => {
        const v6: NetworkInterfaceInfo = { name: 'en0', address: 'fe80::1', family: 'ipv6', tunnel: false };
        expect(assessHairpin({ interfaces: [v6, tunnel()], hostIp: GATEWAY }).onSameLan).toBe(false);
    });
});
