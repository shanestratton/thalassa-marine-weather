import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Same tripwire as the barometer's: an app-local Capacitor plugin missing from
 * the pbxproj build graph, or from the bridge's manual registration, fails by
 * returning "not implemented on ios" — so the hairpin check would silently
 * never fire, which is indistinguishable from there being no hairpin.
 */
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const native = read('ios/App/App/NetworkInterfacesPlugin.swift');
const objc = read('ios/App/App/NetworkInterfacesPlugin.m');
const bridge = read('ios/App/App/ThalassaBridgeViewController.swift');
const xcode = read('ios/App/App.xcodeproj/project.pbxproj');
const service = read('services/network/networkContext.ts');

describe('NetworkInterfaces plugin contract', () => {
    it('walks real interfaces and flags tunnels', () => {
        expect(native).toContain('getifaddrs');
        expect(native).toContain('freeifaddrs');
        expect(native).toContain('utun');
        expect(native).toContain('"vpnActive"');
    });

    it('skips interfaces that say nothing about which network we are on', () => {
        expect(native).toContain('IFF_LOOPBACK');
        expect(native).toContain('IFF_UP');
    });

    it('is bridged, compiled and manually registered', () => {
        expect(objc).toContain('CAP_PLUGIN(NetworkInterfacesPlugin, "NetworkInterfaces"');
        expect(bridge).toContain('registerPluginInstance(NetworkInterfacesPlugin())');
        expect(xcode).toMatch(/NetworkInterfacesPlugin\.swift in Sources/);
        expect(xcode).toMatch(/NetworkInterfacesPlugin\.m in Sources/);
        expect(service).toContain("registerPlugin<NetworkInterfacesPlugin>('NetworkInterfaces')");
    });

    it('fails closed — an unreadable network is never a warning', () => {
        expect(service).toContain('return [];');
        expect(service).toContain("Capacitor.getPlatform() !== 'ios'");
    });
});
