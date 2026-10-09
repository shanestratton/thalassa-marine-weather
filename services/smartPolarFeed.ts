/**
 * smartPolarFeed — what the Smart Polars learner hears (build 126, package
 * 126-B6a; polars-01).
 *
 * One source at a time, never both:
 *   - this phone's gateway socket: NmeaListenerService's samples, straight
 *     through (a boat with no Pi);
 *   - the Pi over the boat link (its LAN or tailnet address), read from
 *     NmeaStore, where PiTelemetryService puts it. With a Pi paired the socket
 *     stays shut (Shane 2026-09-07: "no more signal k or ydwg-02 on the actual
 *     phone unless there is no pi available"), so before this the learner
 *     heard nothing on a Pi boat at all.
 *
 * A Pi sample goes to the learner only when the store is fed by source 'pi'
 * over 'lan' — a crew phone's shared GPS ('device') is not instruments, and
 * the cloud row never teaches it (the boat seen from ashore, up to a minute
 * old: the cloud never steers) — and only when the Pi's reading has moved on
 * since the last one, at most once per NMEA_SAMPLE_INTERVAL_MS. Each value is
 * taken while that metric is live, else null. The sample carries this phone's
 * clock: the learner's 30 s window compares against Date.now(), and a Pi clock
 * a minute out would otherwise drop every sample.
 *
 * The wind only when the Pi dated it. The store stamps every remote metric
 * with this phone's receipt time, and Signal K holds a quiet sensor's last
 * value, so a masthead unit gone quiet would keep "live" TWS/TWA beside a
 * moving boat speed. The Pi sends the TWS leaf's own time only while it is
 * fresh (NmeaStore.getRemoteWindSample); a sample takes TWS and TWA — off the
 * same wind sentences — only when that time has moved on since the last
 * sample, else both are null and nothing is recorded.
 *
 * The two cannot double-count: NmeaStore refuses remote data while the socket
 * is connected, and the Pi lane here stands down while it is.
 *
 * It only listens, and a fault in the learner stays in the learner: these
 * callbacks run inside NmeaStore.notify and the Pi's poll, which feed the
 * Instrument Panel, Anchor Watch and the Log. Which link is up stays
 * InstrumentSourcePolicy's call.
 */
import type { NmeaSample } from '../types';
import { NmeaListenerService } from './NmeaListenerService';
import { NmeaStore, getNmeaFreshness, type NmeaStoreState, type TimestampedMetric } from './NmeaStore';
import { PiTelemetryService } from './PiTelemetryService';
import { NMEA_SAMPLE_INTERVAL_MS } from './nmea/nmeaCadence';
import { createLogger } from '../utils/createLogger';

const log = createLogger('SmartPolarFeed');

/** The fields the learner's gates read. */
export type LearnerSample = Pick<NmeaSample, 'timestamp' | 'tws' | 'twa' | 'stw' | 'heading' | 'rpm' | 'voltage'> &
    Partial<Pick<NmeaSample, 'sog'>>;

/**
 * Where the learner hears the boat from: the Pi, the gateway, the cloud row
 * only (nothing to learn), the Pi answering with her instruments quiet, or
 * nowhere.
 */
export type LearnerFeedState = 'pi' | 'gateway' | 'cloud' | 'quiet' | 'none';

const piOverBoatLink = (s: NmeaStoreState): boolean =>
    s.connectionStatus === 'remote' && s.remote?.via === 'lan' && s.remote.source === 'pi';

/** Runs a learner callback; a throw is logged and goes no further. */
function isolated<T>(cb: (value: T) => void): (value: T) => void {
    let warned = false;
    return (value) => {
        try {
            cb(value);
        } catch (e) {
            if (!warned) log.warn('Smart Polars skipped a reading:', e instanceof Error ? e.name : 'error');
            warned = true;
        }
    };
}

export function learnerFeedState(): LearnerFeedState {
    if (NmeaListenerService.getStatus() === 'connected') return 'gateway';
    const s = NmeaStore.getState();
    if (s.connectionStatus === 'remote' && s.remote) return piOverBoatLink(s) ? 'pi' : 'cloud';
    return PiTelemetryService.getState() === 'quiet' ? 'quiet' : 'none';
}

/** Calls back on each change of learnerFeedState. Returns the unsubscribe. */
export function subscribeLearnerFeedState(cb: (state: LearnerFeedState) => void): () => void {
    let last = learnerFeedState();
    const check = isolated<unknown>(() => {
        const next = learnerFeedState();
        if (next !== last) cb((last = next));
    });
    const offs = [
        NmeaStore.subscribe(check),
        NmeaListenerService.onStatusChange(check),
        PiTelemetryService.subscribe(check),
    ];
    return () => offs.forEach((off) => off());
}

/** Learner samples from whichever source is feeding. Returns the unsubscribe. */
export function subscribeLearnerSamples(cb: (sample: LearnerSample) => void): () => void {
    const emit = isolated(cb);
    let lastReportedAt = 0;
    let lastWindAt = 0;
    let lastEmitAt = -Infinity;
    let hearingPi = false;
    const offSocket = NmeaListenerService.onSample(emit);
    const offStore = NmeaStore.subscribe((s) => {
        const pi = piOverBoatLink(s) && NmeaListenerService.getStatus() !== 'connected';
        if (hearingPi && !pi) log.warn('the Pi’s instruments stopped reaching Smart Polars');
        hearingPi = pi;
        const remote = s.remote;
        // "Moved on" is a different reading, not a later clock: a Pi clock
        // stepped back must not silence the learner until it catches up.
        if (!pi || !remote || remote.reportedAt === lastReportedAt) return;
        const now = Date.now();
        if (now - lastEmitAt < NMEA_SAMPLE_INTERVAL_MS) return;
        lastReportedAt = remote.reportedAt;
        lastEmitAt = now;
        const live = (m: TimestampedMetric) => (getNmeaFreshness(m.lastUpdated, now) === 'live' ? m.value : null);
        const wind = NmeaStore.getRemoteWindSample();
        const windNew = wind !== null && wind.via === 'lan' && wind.at !== lastWindAt;
        if (windNew) lastWindAt = wind.at;
        emit({
            timestamp: now,
            tws: windNew ? wind.kts : null,
            twa: windNew ? live(s.twa) : null,
            stw: live(s.stw),
            heading: live(s.heading),
            rpm: live(s.rpm),
            voltage: live(s.voltage),
            sog: live(s.sog),
        });
    });
    return () => {
        offSocket();
        offStore();
    };
}
