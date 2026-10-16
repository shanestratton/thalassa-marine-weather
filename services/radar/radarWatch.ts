/** App-lifetime radar watch: qualified physical evidence only, independent of map and AIS filters. */
import { RadarStore } from './radarStore';
import { RadarAlarmStore } from './radarAlarmStore';
import { retainPiRadar } from './radarPiSession';
import { AisGuardZone } from '../AisGuardZone';
import { CollisionAlarmService, type RadarSoundContribution } from '../CollisionAlarmService';
import { readCollisionAnchorWatch } from '../collisionAnchorWatch';
import { useSettingsStore } from '../../stores/settingsStore';
import { gradeRadarContact, radarCollisionOwnship } from '../../utils/radarCollision';
import { ownMotionState, sanitiseCollisionPrefs, type CollisionPairName } from '../../utils/collisionRule';
import type { EncounterOwnState } from '../../utils/collisionEncounter';
import { subscribeAuthIdentityScope } from '../authIdentityScope';
let stop: (() => void) | null = null;
let releasePi: (() => void) | null = null;
let pairs = new Map<string, CollisionPairName>();

function sound(): void {
    const state = RadarAlarmStore.get(),
        now = Date.now();
    const sounds: RadarSoundContribution[] = state.cards
        .filter((c) => !c.cleared)
        .map((c) => ({
            key: `${c.contactKey}:${c.episodeId}:${c.closeQuarters ? 'close' : 'danger'}`,
            title: `Radar ${c.closeQuarters ? 'close quarters' : 'collision risk'}: ${c.name}`,
            body: `${c.lost ? 'CPA unknown; not shown clear' : `CPA ${c.assessment.cpaNm?.toFixed(2) ?? 'unknown'} NM, TCPA ${c.assessment.tcpaMin?.toFixed(1) ?? 'unknown'} min`}. Radar target ${c.targetNumber}; original report ${Math.max(0, Math.round((now - c.reportAt) / 1000))} s old.`,
        }));
    if (state.capacity && !state.capacity.acknowledged)
        sounds.push({
            key: `radar-capacity:${state.capacity.sourceAt}`,
            title: 'Radar watch capacity reached',
            body: 'More qualified threats were reported than can be held. Existing alarms remain; the radar picture is incomplete.',
        });
    CollisionAlarmService.updateRadar(sounds, {
        armed: state.armed,
        nowMs: now,
        lost: state.cards.some((c) => c.cleared === 'lost'),
    });
}
export function runRadarWatch(now = Date.now()): void {
    const guard = AisGuardZone.getState();
    const armed = guard.enabled && guard.collisionChecked === true;
    RadarAlarmStore.setArmed(armed);
    if (!armed) {
        releasePi?.();
        releasePi = null;
        pairs.clear();
        return;
    }
    releasePi ??= retainPiRadar();
    const picture = RadarStore.getSnapshot(),
        prefs = sanitiseCollisionPrefs(useSettingsStore.getState().settings?.collisionAlarm);
    const feeds = new Map(picture.feeds.map((f) => [f.feedId, f]));
    const own = new Map<string, { state: EncounterOwnState; atAnchor: boolean }>();
    for (const f of picture.feeds) {
        const qualified = radarCollisionOwnship(f.ownship, f.feedId, now);
        const atAnchor =
            !!qualified &&
            readCollisionAnchorWatch({ lat: qualified.lat, lon: qualified.lon, source: 'nmea' }) === 'at-anchor';
        own.set(f.feedId, {
            state: qualified ? ownMotionState(qualified.sogKn, qualified.cogDeg, atAnchor) : 'no-fix',
            atAnchor,
        });
    }
    const candidates = picture.contacts.flatMap((c) => {
        const candidate = gradeRadarContact(
            c,
            feeds.get(c.feedId)?.ownship ?? null,
            now,
            prefs,
            own.get(c.feedId)?.atAnchor,
            pairs.get(c.contactKey),
        );
        return candidate ? [candidate] : [];
    });
    pairs = new Map(candidates.map((c) => [c.contactKey, c.assessment.pair]));
    RadarAlarmStore.update(
        candidates,
        (c, key) => {
            const feedId = c?.contact.feedId ?? /^radar:(.+):[A-Z0-9]{2}:\d+$/.exec(key)?.[1];
            return feedId ? (own.get(feedId)?.state ?? 'no-fix') : 'no-fix';
        },
        {
            feeds: picture.feeds.length,
            qualifiedFeeds: [...own.values()].filter((o) => o.state === 'moving' || o.state === 'stopped').length,
        },
        now,
    );
}
export function startRadarWatch(): () => void {
    if (stop) return stop;
    let closed = false,
        queued = false;
    const queue = () => {
        if (queued || closed) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (!closed) runRadarWatch();
        });
    };
    const disposers = [
        RadarStore.subscribe(queue),
        AisGuardZone.subscribe(() => runRadarWatch()),
        useSettingsStore.subscribe(queue),
        subscribeAuthIdentityScope(queue),
        RadarAlarmStore.subscribe(sound),
    ];
    const timer = setInterval(queue, 1000);
    runRadarWatch();
    stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        disposers.forEach((fn) => fn());
        releasePi?.();
        releasePi = null;
        pairs.clear();
        RadarAlarmStore.setArmed(false);
        sound();
        stop = null;
    };
    return stop;
}
