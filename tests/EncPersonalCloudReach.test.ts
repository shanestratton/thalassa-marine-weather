/**
 * Chart backup had no route off a phone without a Pi.
 *
 * EncPersonalCloudPanel is pure Supabase — no Pi module in it, none in
 * personalCellSync — but its only mount was inside EncCellManager, which
 * renders only when PI_INTEGRATION_ENABLED. So the web build at
 * thalassawx.app, and any native build without the pinning plugin, could
 * DOWNLOAD your personal cells and never publish or back one up. Paid Nouméa
 * and Port Vila cells had no way off the phone they were imported on.
 *
 * It was also buried inside a collapsed card on a page about hardware
 * discovery, which is not where anyone looks for a backup.
 *
 * The auto-publish toggle travels with it — it is the only off switch for a
 * publish that otherwise fires unattended after every Pi sync.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const account = readFileSync('components/settings/AccountTab.tsx', 'utf8');
const encCard = readFileSync('components/vessel/EncCellManager.tsx', 'utf8');
const panel = readFileSync('components/vessel/EncPersonalCloudPanel.tsx', 'utf8');
const sync = readFileSync('services/enc/personalCellSync.ts', 'utf8');

describe('where chart backup lives', () => {
    it('is mounted in Settings → System & Cloud, which needs no Pi', () => {
        expect(account).toContain("import { EncPersonalCloudPanel } from '../vessel/EncPersonalCloudPanel';");
        expect(account).toContain('<EncPersonalCloudPanel />');
    });

    it('sits in the section that already promises private cross-device sync', () => {
        const cloud = account.slice(account.indexOf('<Section title="Cloud Data">'));
        expect(cloud.slice(0, cloud.indexOf('</Section>'))).toContain('<EncPersonalCloudPanel />');
    });

    it('is no longer behind the Pi-only card', () => {
        expect(encCard).not.toContain('EncPersonalCloudPanel');
    });
});

describe('it can honestly live outside the Pi build', () => {
    it('the panel imports no Pi module', () => {
        expect(panel).not.toMatch(/piCache|PiCacheService|EncImportService|PI_INTEGRATION_ENABLED/);
    });

    it('and neither does the service behind it', () => {
        expect(sync).not.toMatch(/piCache|PiCacheService|EncImportService/);
    });
});

describe('the off switch travelled with it', () => {
    it('keeps the auto-publish toggle in the panel that moved', () => {
        // Auto-publish fires unattended after every Pi sync. Moving the
        // button without its toggle would leave no way to stop it.
        expect(panel).toContain('setAutoPublishEnabled');
        expect(panel).toContain('isAutoPublishEnabled');
    });

    it('still refuses to spend 400 MB unasked — the first publish stays a button', () => {
        // A VPN makes iOS report 'wifi' while actually on cellular, so the
        // network type is not trustworthy enough to spend a marina 4G plan
        // on. The panel's header explains that at length; what matters here
        // is that it never actually READS it.
        expect(panel).toContain('getPublishPlan');
        expect(panel).not.toContain("from '@capacitor/network'");
        expect(panel).not.toContain('Network.getStatus');
    });
});
