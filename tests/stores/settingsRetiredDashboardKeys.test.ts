/**
 * The customisable-forecast-dashboard settings are retired (build 126, gap
 * #105): heroWidgets, detailsWidgets, rowOrder and topHeroWidget had no
 * reader left in the app. The Glass grid is fixed, and the only hero choice
 * that survives is heroMetric (MetricPinSheet), which is untouched.
 *
 * Phones and accounts still carry the old keys: on disk (Capacitor
 * Preferences), in the warm-boot localStorage mirror and in the cloud
 * user_settings row. They must load without error, and they are dropped on
 * the way in, so the next save no longer writes them back anywhere.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeCloudSettings, mergeSettings } from '../../stores/settingsStore';

const RETIRED = ['heroWidgets', 'detailsWidgets', 'rowOrder', 'topHeroWidget'] as const;

/** A settings blob exactly as builds up to 125 persisted it. */
const OLD_BLOB = {
    firstName: 'Alex',
    heroMetric: 'gust',
    units: { temp: 'F', speed: 'kts' },
    heroWidgets: ['wind', 'wave', 'pressure'],
    topHeroWidget: 'wind',
    detailsWidgets: ['score', 'pressure', 'humidity', 'precip', 'cloud', 'visibility', 'chill', 'swell'],
    rowOrder: ['beaufort', 'details', 'charts', 'forecastChart', 'tides', 'advice', 'map'],
};

describe('retired dashboard widget settings', () => {
    it('are gone from the defaults', () => {
        for (const key of RETIRED) expect(DEFAULT_SETTINGS).not.toHaveProperty(key);
    });

    it('an old saved blob still loads, keeps everything else, and sheds the retired keys', () => {
        const merged = mergeSettings(OLD_BLOB);
        for (const key of RETIRED) expect(merged).not.toHaveProperty(key);
        expect(merged.firstName).toBe('Alex');
        expect(merged.heroMetric).toBe('gust');
        expect(merged.units.temp).toBe('F');
    });

    it('tolerates malformed old values too', () => {
        expect(() =>
            mergeSettings({ heroWidgets: 'nope', rowOrder: 42, detailsWidgets: null, topHeroWidget: {} }),
        ).not.toThrow();
        const merged = mergeSettings({ heroWidgets: 'nope', rowOrder: 42, detailsWidgets: null, topHeroWidget: {} });
        for (const key of RETIRED) expect(merged).not.toHaveProperty(key);
    });

    it('a cloud row that still carries them cannot bring them back', () => {
        const current = mergeSettings({ firstName: 'Alex' });
        const merged = mergeCloudSettings(current, OLD_BLOB as never, current.vessel);
        for (const key of RETIRED) expect(merged).not.toHaveProperty(key);
        expect(merged.firstName).toBe('Alex');
        expect(merged.heroMetric).toBe('gust');
    });

    it('leave no migration behind for a row order nothing reads', () => {
        const store = readFileSync(join(process.cwd(), 'stores/settingsStore.ts'), 'utf8');
        expect(store).not.toContain('migrateRowOrder');
        const types = readFileSync(join(process.cwd(), 'types/settings.ts'), 'utf8');
        for (const key of RETIRED) expect(types).not.toMatch(new RegExp(`\\b${key}\\?:`));
    });
});
