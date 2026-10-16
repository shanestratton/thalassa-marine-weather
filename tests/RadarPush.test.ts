import { describe, expect, it, vi, beforeEach } from 'vitest';
const f = vi.hoisted(() => ({ refresh: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/radar/piRadarWatchState', () => ({ PiRadarWatchStateStore: { refresh: f.refresh } }));
import { refreshRadarAlarmPush } from '../services/radar/radarPush';
beforeEach(() => f.refresh.mockClear());
describe('native radar push refresh boundary', () => {
    it('does not install payload facts or acknowledge a payload key', () => {
        expect(
            refreshRadarAlarmPush({
                notification_type: 'radar_alarm',
                key: 'untrusted',
                ownerId: 'other',
                acknowledged: true,
                frames: ['private'],
                cpaNm: 0,
            }),
        ).toBe(true);
        expect(f.refresh).toHaveBeenCalledExactlyOnceWith(false);
    });
    it('only an explicit tap allows a bounded cloud refresh in Satellite Mode', () => {
        refreshRadarAlarmPush({ notification_type: 'radar_alarm' }, true);
        expect(f.refresh).toHaveBeenCalledExactlyOnceWith(true);
    });
    it('leaves every existing push family to its existing handler', () => {
        for (const notification_type of ['collision_alarm', 'distress_alarm', 'wake_alarm', 'weather_alert', 'dm'])
            expect(refreshRadarAlarmPush({ notification_type })).toBe(false);
        expect(f.refresh).not.toHaveBeenCalled();
    });
});
