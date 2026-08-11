import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    PI_DISABLED_BASE_URL,
    PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE,
    resolvePiIntegrationEnabled,
} from '../services/piPublicBetaBoundary';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

/**
 * The Pi boundary was "development builds only" while the boat LAN was plain
 * HTTP. Since 2026-08-06 the transport is TLS pinned to the Pi's pairing key,
 * so the gate is now "does this build contain the native verifier" rather than
 * "is this a dev build".
 *
 * These tests guard the properties that make that safe. The important ones are
 * the negatives: no cleartext lane, no unpinned data path, no build-time
 * override.
 */
describe('Pi pinned-transport boundary', () => {
    it('opens only for a build that actually carries the pinning verifier', () => {
        expect(resolvePiIntegrationEnabled({ dev: false, pinnedTransport: true })).toBe(true);
        expect(resolvePiIntegrationEnabled({ dev: true, pinnedTransport: false })).toBe(true);
        // The case that used to be the whole hold: a shipped build with no way
        // to verify the certificate gets no Pi at all.
        expect(resolvePiIntegrationEnabled({ dev: false, pinnedTransport: false })).toBe(false);
        expect(PI_DISABLED_BASE_URL.startsWith('http')).toBe(false);
    });

    it('refuses to accept a build-time flag as authorization', () => {
        const boundary = read('services/piPublicBetaBoundary.ts');
        // A VITE_ value is user-readable and user-settable; it cannot authorize
        // a transport. Presence of the native verifier is the only opener.
        expect(boundary).not.toMatch(/import\.meta\.env\.VITE_PI/);
        expect(boundary).toContain('isPinnedTransportAvailable()');
        expect(PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE).toMatch(/pinned/i);
    });

    it('has no cleartext lane left to the Pi', () => {
        const cacheService = read('services/PiCacheService.ts');
        const pairing = read('services/PiPairingService.ts');
        const transport = read('services/piTls.ts');

        // The 2026-08-11 Tailscale lane made the HOST a ladder (LAN first,
        // tailnet fallback) — but the SCHEME is not a choice: whichever host
        // wins, it is interpolated into the one https template.
        expect(cacheService).toContain(
            'const host = this._useRemote && this.remoteHost ? this.remoteHost : this.config.host;',
        );
        expect(cacheService).toContain('return `https://${host}:${this.config.port}`');
        expect(cacheService).not.toMatch(/`http:\/\/\$\{/);
        expect(pairing).not.toMatch(/`http:\/\/\$\{/);
        // The transport refuses a downgrade even if a caller builds one.
        expect(transport).toContain("if (!options.url.startsWith('https://'))");
    });

    it('routes every Pi call through the pinning transport, not CapacitorHttp', () => {
        // Comments in this file explain what it deliberately does NOT use, so
        // strip them before asserting absence.
        const pairing = read('services/PiPairingService.ts')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        expect(pairing).not.toContain('CapacitorHttp');
        expect(pairing).toContain("from './piTls'");
        expect(pairing).toContain('piPairingFetch');
        expect(pairing).toContain('piRequest');
        // The verified-read helper must pin, or the signature check it performs
        // is running over a channel anything could have terminated.
        expect(pairing).toContain('pinnedSpki: getPairing()?.publicKeySpki');
    });

    it('binds pairing to the TLS channel and refuses an unbindable one', () => {
        const pairing = read('services/PiPairingService.ts');
        // The advertised key must be the key that terminated the session.
        expect(pairing).toContain('res.peerSpki !== data.publicKeySpki');
        expect(pairing).toContain('if (!res.peerSpki)');
    });

    it('lets exactly one path be fetched without a pin, enforced natively', () => {
        const plugin = read('ios/App/App/PiTlsPlugin.swift');
        expect(plugin).toContain('private static let unpinnedPath = "/api/pair/info"');
        expect(plugin).toContain('if pin == nil && url.path != Self.unpinnedPath');
        // Trust is the pinned key alone — never the system trust store.
        expect(plugin).not.toContain('SecTrustEvaluateWithError');
        expect(plugin).toContain('constantTimeEquals(presented, pinnedSpki)');
        // Never relax the whole app to accommodate one host.
        expect(read('ios/App/App/Info.plist')).not.toContain('NSAllowsArbitraryLoads');
        expect(read('ios/App/App/ThalassaBridgeViewController.swift')).toContain(
            'bridge?.registerPluginInstance(PiTlsPlugin())',
        );
    });

    it('anchors the certificate to the pairing identity on the Pi', () => {
        const tls = read('pi-cache/src/tlsIdentity.ts');
        const server = read('pi-cache/src/server.ts');
        // Same key as pairing — that equality IS the trust anchor.
        expect(tls).toContain('TLS certificate public key does not match the Pi pairing identity');
        expect(server).toContain('https.createServer(');
        expect(server).toContain("minVersion: 'TLSv1.2'");
        // The plaintext port must stay a signpost: no redirect (which would put
        // the requested path back on the wire) and no app data.
        expect(server).toContain('plaintextSignpost');
        expect(server).not.toMatch(/plaintextSignpost[\s\S]{0,600}writeHead\(30\d/);
        // The private key must not ride on the object handed to route handlers.
        expect(read('pi-cache/src/identity.ts')).toContain('export function readIdentityPrivateKeyPem');
        expect(read('pi-cache/src/routes/pair.ts')).not.toContain('privateKey');
    });

    it('keeps boot discovery, health, and URL fallback gated', () => {
        const service = read('services/PiCacheService.ts');
        expect(service).toContain('if (!PI_INTEGRATION_ENABLED)');
        expect(service).toContain("this.configure({ enabled: false, host: '', port: 3001 })");
        expect(service).toContain('return PI_INTEGRATION_ENABLED && this.config.enabled && this.status.reachable');
        expect(service).toContain('return PI_DISABLED_BASE_URL');
    });

    it('keeps the production ENC Library independent from every Pi module', () => {
        const page = read('components/vessel/EncLibraryPage.tsx');
        const importer = read('services/enc/localEncPackImport.ts');
        expect(page).not.toMatch(/EncCellManager|EncImportService|PiCacheService/);
        expect(importer).not.toMatch(/EncImportService|PiCacheService|piCache|CapacitorHttp/);
        expect(importer).toContain("url.protocol !== 'https:'");
        expect(importer).toContain("{ usage: 'reference' }");
    });
});
