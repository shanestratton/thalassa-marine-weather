import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadarPictureSnapshot } from '../services/radar/radarStore';
const f = vi.hoisted(() => ({
    picture: { version: 0, contacts: [], feeds: [] } as RadarPictureSnapshot,
    guard: { enabled: true, collisionChecked: true },
    listeners: new Set<() => void>(),
    release: vi.fn(),
    retain: vi.fn(),
    delivery: vi.fn(),
}));
vi.mock('../services/radar/radarStore', () => ({
    RadarStore: {
        getSnapshot: () => f.picture,
        subscribe: (fn: () => void) => {
            f.listeners.add(fn);
            return () => f.listeners.delete(fn);
        },
    },
}));
vi.mock('../services/radar/radarPiSession', () => ({ retainPiRadar: f.retain }));
vi.mock('../services/AisGuardZone', () => ({ AisGuardZone: { getState: () => f.guard, subscribe: () => () => {} } }));
vi.mock('../services/CollisionAlarmService', () => ({ CollisionAlarmService: { updateRadar: f.delivery } }));
vi.mock('../services/collisionAnchorWatch', () => ({ readCollisionAnchorWatch: () => 'off' }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ settings: { aisMinSpeed: 99, aisHideMoored: true, collisionAlarm: {} } }),
        subscribe: () => () => {},
    },
}));
import { startRadarWatch, runRadarWatch } from '../services/radar/radarWatch';
import { RadarAlarmStore } from '../services/radar/radarAlarmStore';
import { RadarFeed } from '../utils/radarFeed';
const T = Date.UTC(2026, 0, 2, 12);
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
let stop: (() => void) | null;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    f.guard = { enabled: true, collisionChecked: true };
    f.listeners.clear();
    f.release.mockReset();
    f.retain.mockReset().mockReturnValue(f.release);
    f.delivery.mockReset();
    RadarAlarmStore.setArmed(false);
    const feed = new RadarFeed('gateway:generated');
    for (const body of [
        'GPRMC,120000,A,0000.000,N,00000.000,E,5,0,020126,,,A',
        'HEHDT,0,T',
        'RATTM,1,1,0,R,10,180,R,0,6,N,Generated,T,,120000,A',
    ])
        feed.ingest(frame(body), T, T);
    f.picture = {
        version: 1,
        contacts: feed.contacts(T),
        feeds: [
            {
                feedId: feed.feedId,
                source: 'gateway',
                ownship: feed.ownshipSnapshot(),
                lastFrameAt: T,
                lastTargetAt: T,
            },
        ],
    };
});
afterEach(() => {
    stop?.();
    stop = null;
    RadarAlarmStore.setArmed(false);
    vi.useRealTimers();
});
describe('app-lifetime qualified radar watch', () => {
    it('runs without a map or phone GPS and ignores AIS display filters', () => {
        stop = startRadarWatch();
        expect(RadarAlarmStore.get().cards).toHaveLength(1);
        expect(f.delivery.mock.calls.at(-1)![0][0]).toMatchObject({ title: 'Radar collision risk: Generated' });
        expect(f.retain).toHaveBeenCalledOnce();
    });
    it('a collision shield without its explicit sound check cannot arm radar', () => {
        f.guard.collisionChecked = false;
        stop = startRadarWatch();
        expect(RadarAlarmStore.get().armed).toBe(false);
        expect(f.retain).not.toHaveBeenCalled();
    });
    it('does not borrow navigation from another physical input', () => {
        const own = f.picture.feeds[0].ownship!;
        f.picture = { ...f.picture, feeds: [{ ...f.picture.feeds[0], ownship: { ...own, feedId: 'gateway:other' } }] };
        stop = startRadarWatch();
        expect(RadarAlarmStore.get().cards).toHaveLength(0);
        expect(RadarAlarmStore.get().qualifiedFeeds).toBe(0);
    });
    it('new delivery times cannot refresh old evidence or clear a held danger', () => {
        stop = startRadarWatch();
        vi.setSystemTime(T + 16000);
        runRadarWatch(T + 16000);
        expect(RadarAlarmStore.get().cards[0]).toMatchObject({ sourceAt: T, reportAt: T, lost: { reason: 'no-fix' } });
        expect(RadarAlarmStore.get().cards[0].cleared).toBeUndefined();
        expect(f.delivery.mock.calls.at(-1)![0][0].body).toContain('CPA unknown; not shown clear');
    });
    it('a lost feed keeps the unresolved alarm; explicit disarm releases only this Pi reader lease', () => {
        stop = startRadarWatch();
        f.picture = { version: 2, contacts: [], feeds: [] };
        runRadarWatch(T + 1000);
        expect(RadarAlarmStore.get().cards[0].lost?.reason).toBe('no-fix');
        expect(f.release).not.toHaveBeenCalled();
        f.guard.enabled = false;
        runRadarWatch(T + 2000);
        expect(RadarAlarmStore.get()).toMatchObject({ armed: false, cards: [] });
        expect(f.release).toHaveBeenCalledOnce();
    });
});
