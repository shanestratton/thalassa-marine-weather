import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Calypso proactive-alert public-beta boundary', () => {
    it('fails closed in the UI, app lifecycle, and service boundary', () => {
        const app = read('App.tsx');
        const settings = read('components/settings/CalypsoIntegrationsTab.tsx');
        const service = read('services/AlertMonitorService.ts');

        expect(FEATURE_VISIBILITY.calypsoAlerts).toBe(false);
        expect(app).toContain('FEATURE_VISIBILITY.calypsoAlerts && (settings.calypsoAlertsEnabled ?? false)');
        expect(app).toContain('void updateSettings({ calypsoAlertsEnabled: false })');
        expect(settings).toContain('!FEATURE_VISIBILITY.calypsoAlerts ? (');
        expect(settings).toContain('Proactive alerts unavailable in public beta');
        expect(settings).toContain('not running as a background or terminated-app vessel monitor');
        expect(service).toContain("FEATURE_VISIBILITY.calypsoAlerts || import.meta.env.MODE === 'test'");
        expect(service).toContain('if (!alertMonitorRuntimeEnabled())');
    });

    it('does not claim Critical Alert or background-audio protection in the active-path copy', () => {
        const settings = read('components/settings/CalypsoIntegrationsTab.tsx');
        const notifier = read('services/AlertNotifier.ts');

        expect(settings).toContain('not a Critical Alert or independent vessel alarm');
        expect(settings).toContain('Monitoring can stop when the app is backgrounded');
        expect(notifier).toContain('not a background, terminated-app, or Critical Alert channel');
        expect(notifier).not.toContain('audible even when the app is backgrounded');
    });
});
