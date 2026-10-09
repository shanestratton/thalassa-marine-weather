/**
 * Her trail ashore (126-03a): the positions this phone has heard in Shore
 * Watch, kept as half-minute means for the radar.
 *
 * The broadcast carries only the latest fix (the Pi sends every 10 s, a boat's
 * phone every 5 s), so nothing else keeps a history ashore. SwingTrack, the
 * boat's own store for judging a move, already keeps 24 h of half-minute
 * means, safe across 180° and deaf to replays of a closed half-minute; it is
 * reused here, one per session code.
 *
 * App-lifetime: started once beside the shore alarm (GlobalShoreWatchGate), so
 * the trail grows while Shore Watch's page is closed. Memory only: a storage
 * write every ten seconds for a nicety is not worth the battery. Each mean
 * keeps its time, so the radar draws only the newest stretch heard without a
 * gap and says when it starts (shoreSwingModel).
 *
 * A new session code starts a new trail; a moved mark (126-07a) keeps it: it
 * is her track, not the mark's.
 */
import { SHORE_TRAIL_DRAW_MAX } from '../components/anchor-watch/shoreSwingModel';
import { AnchorWatchSyncService, type SyncBroadcast, type SyncState } from './AnchorWatchSyncService';
import { SwingTrack, type TrailFix } from './anchorLateSet';

/** ShoreWatchAlarmService's SHORE_POSITION_STALE_MS: a fix older than this is not "heard now". */
const STALE_MS = 35_000;
const FUTURE_SKEW_MS = 30_000;

const validTime = (value: unknown, now: number): value is number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    now - value <= STALE_MS &&
    value <= now + FUTURE_SKEW_MS;

const validPlace = (value: { latitude: number; longitude: number } | undefined): boolean =>
    !!value &&
    Number.isFinite(value.latitude) &&
    Math.abs(value.latitude) <= 90 &&
    Number.isFinite(value.longitude) &&
    Math.abs(value.longitude) <= 180;

export class ShoreSwingTrailStore {
    private started = false;
    private sessionCode: string | null = null;
    private tracks = new Map<string, SwingTrack>();
    /** The newest fix taken, so a replayed or late packet adds nothing, inside a half-minute too. */
    private lastFixAt = -Infinity;
    /** Cleared whenever the trail changes. */
    private cache = new Map<string, TrailFix[]>();

    /** Idempotent: subscribes once, for the app's lifetime. */
    start(): void {
        if (this.started) return;
        this.started = true;
        AnchorWatchSyncService.onStateChange((state) => this.receiveState(state));
        AnchorWatchSyncService.onBroadcast((data) => this.receive(data));
        const latest = AnchorWatchSyncService.getLatestPosition();
        if (latest) this.receive(latest);
    }

    /**
     * The newest `max` half-minute means of this session's trail, oldest first.
     * The same array until the trail changes, so a page that renders every
     * second does not rebuild the radar's model each time.
     */
    points(sessionCode: string | null, max = SHORE_TRAIL_DRAW_MAX): TrailFix[] {
        const key = `${sessionCode}:${max}`;
        const cached = this.cache.get(key);
        if (cached) return cached;
        const all = (sessionCode && this.tracks.get(sessionCode)?.points()) || [];
        const points = all.length > max ? all.slice(all.length - max) : all;
        this.cache.set(key, points);
        return points;
    }

    private receiveState(state: SyncState): void {
        const sessionCode = state.role === 'shore' ? state.sessionCode : null;
        if (sessionCode === this.sessionCode) return;
        this.sessionCode = sessionCode;
        this.tracks.clear();
        this.lastFixAt = -Infinity;
        this.cache.clear();
    }

    /** The same test the shore alarm applies (ShoreWatchAlarmService.receive): a fresh, whole position fix. */
    private receive(data: SyncBroadcast): void {
        const code = this.sessionCode;
        if (!code || data.type !== 'position') return;
        const now = Date.now();
        const fixAt = data.vessel?.timestamp;
        if (!validTime(data.timestamp, now) || !validTime(fixAt, now) || !(fixAt > this.lastFixAt)) return;
        if (!validPlace(data.vessel) || !validPlace(data.anchor)) return;
        if (!Number.isFinite(data.distance) || data.distance < 0) return;
        if (!Number.isFinite(data.swingRadius) || data.swingRadius <= 0) return;
        if (data.isAlarm !== true && data.isAlarm !== false) return;
        let track = this.tracks.get(code);
        if (!track) this.tracks.set(code, (track = new SwingTrack()));
        const accuracy = data.vessel.accuracy;
        track.add({
            latitude: data.vessel.latitude,
            longitude: data.vessel.longitude,
            accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 0,
            timestamp: fixAt,
        });
        this.lastFixAt = fixAt;
        this.cache.clear();
    }
}

export const ShoreSwingTrail = new ShoreSwingTrailStore();
