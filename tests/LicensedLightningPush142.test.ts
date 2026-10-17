import { describe, expect, it } from 'vitest';
import { isCurrentLightningNotice } from '../utils/licensedLightningPush';
import {
    getApnsExpiration,
    getThreadId,
    isCriticalType,
    isStaleForDelivery,
} from '../supabase/functions/send-push/config';
const NOW = 1792230000000;
const data = {
    type: 'lightning_nearby',
    notification_type: 'lightning_nearby',
    provider: 'xweather',
    pulse_id: 'fictional-pulse',
    source_at: NOW - 30000,
    expires_at: NOW + 60000,
};
describe('Licensed lightning informational push source clocks', () => {
    it('accepts an original current licensed notice without a critical override or APNs backlog', () => {
        expect(isCurrentLightningNotice(data, NOW)).toBe(true);
        expect(isCriticalType('lightning_nearby')).toBe(false);
        expect(getThreadId('lightning_nearby')).toBe('thalassa-weather');
        expect(getApnsExpiration('lightning_nearby', false, NOW, data)).toBe('0');
        expect(isStaleForDelivery('lightning_nearby', new Date(NOW).toISOString(), NOW, data)).toBe(false);
    });
    it('refuses stale queue entries, altered provider/source identity and optical flashes', () => {
        for (const extra of [
            { provider: 'goes-glm' },
            { source_at: NOW + 1 },
            { expires_at: NOW },
            { type: 'weather_alert' },
            { pulse_id: '../untrusted' },
            { expires_at: NOW + 300001 },
            { source_at: String(NOW) },
        ])
            expect(isCurrentLightningNotice({ ...data, ...extra }, NOW)).toBe(false);
        expect(isStaleForDelivery('lightning_nearby', new Date(NOW - 60000).toISOString(), NOW, data)).toBe(true);
        expect(isStaleForDelivery('lightning_nearby', undefined, NOW, data)).toBe(true);
    });
});
