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
 * Since build 126 (126-20) there is nothing to publish: o-charts says
 * unencrypted chart data must never be stored in the cloud, so the card is one
 * plain line about where charts live, the publish and Auto-publish controls
 * are gone, the service is switched off, and the old per-device Auto-publish
 * flag is cleared at every launch so it can never turn uploads back on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const account = readFileSync('components/settings/AccountTab.tsx', 'utf8');
const encCard = readFileSync('components/vessel/EncCellManager.tsx', 'utf8');
const panel = readFileSync('components/vessel/EncPersonalCloudPanel.tsx', 'utf8');
const sync = readFileSync('services/enc/personalCellSync.ts', 'utf8');

describe('where the charts line lives (it was chart backup until 126)', () => {
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

describe('nothing in it can send a chart to the cloud (126-20)', () => {
    it('has no publish and no Auto-publish control left to press', () => {
        // The old card held the only off switch for an upload that fired
        // unattended after every Pi sync. The upload is gone, so the switch
        // goes with it rather than standing as a control that does nothing.
        expect(panel).not.toMatch(/setAutoPublishEnabled|isAutoPublishEnabled|publishPersonalCells|getPublishPlan/);
        expect(panel).not.toContain('<button');
        expect(panel).not.toMatch(/from '[^']*(personalCellSync|supabase)'/);
    });

    it('the service behind the old card is switched off, auto-publish included', () => {
        expect(sync).toContain('export const PERSONAL_CHART_CLOUD_ENABLED = false;');
        const auto = sync.slice(sync.indexOf('export async function publishNewCellsIfEnabled'));
        expect(auto.slice(0, 200)).toContain('if (!PERSONAL_CHART_CLOUD_ENABLED) return;');
    });

    it('the old per-device Auto-publish flag is cleared at every launch', () => {
        // A device that turned it on before 126 keeps '1' in localStorage.
        // Nothing reads it now, but no later build may ever take it as a yes.
        const bootstrap = readFileSync('hooks/useAppBootstrap.ts', 'utf8');
        expect(sync).toContain("const AUTO_PUBLISH_KEY = 'thalassa_enc_auto_publish';");
        expect(bootstrap).toContain("localStorage.removeItem('thalassa_enc_auto_publish');");
    });

    it('still never reads the network type to decide anything', () => {
        // A VPN makes iOS report 'wifi' while actually on cellular, so the
        // network type was never trustworthy enough to spend a marina 4G plan
        // on, and the card that used to spend it must not start reading it.
        expect(panel).not.toContain("from '@capacitor/network'");
        expect(panel).not.toContain('Network.getStatus');
    });
});
