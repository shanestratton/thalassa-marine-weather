/**
 * helmVoice — the offline half of Calypso.
 *
 * Ask "what's the depth" at the helm and this answers from the instruments the
 * app already holds, spoken through the OS synthesiser, with no network call
 * of any kind. Recognition to speech is a few milliseconds and works with the
 * phone in airplane mode, thirty miles out, in a squall.
 *
 * That last clause is the entire justification. Calypso proper is four network
 * hops — speech-to-text, Haiku, a tool fetch, Haiku again, ElevenLabs — and
 * offshore in weather there is marginal signal or none. An assistant that is
 * unavailable exactly when the skipper's hands are full is a gimmick, however
 * good it is at the dock. safetyTts.ts reached this conclusion for MAYDAY
 * already; this applies it to the questions asked a hundred times a passage.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. Only read-only queries. Logging an
 * entry, marking a man overboard and arming an anchor watch are all obvious
 * next verbs, and all of them have side effects — they will be added with the
 * strict-matching discipline helmGrammar already describes, not smuggled in
 * beside the readings. A misheard question costs a repeat; a misheard command
 * costs something real.
 */
import { AnchorWatchService } from '../AnchorWatchService';
import { GpsService } from '../GpsService';
import { NmeaStore } from '../NmeaStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { createLogger } from '../../utils/createLogger';
import { observedTendency } from '../../utils/barometerTendency';
import { answerHelmQuery, type HelmSnapshot, type Reading } from './helmAnswers';
import { parseHelmCommand } from './helmGrammar';

const log = createLogger('helmVoice');

/** NmeaStore's TimestampedMetric, narrowed to what the answers need. */
type StoreMetric = { value: number | null; freshness: 'live' | 'stale' | 'dead' };

const reading = (m: StoreMetric | undefined): Reading => ({
    value: m?.value ?? null,
    freshness: m?.freshness ?? 'dead',
});

/**
 * Collect everything the helm answers can draw on.
 *
 * Every source is wrapped, because this runs while the skipper is steering: a
 * throwing store must degrade to "no reading" rather than take the whole answer
 * down. Silence is the one outcome not worth having.
 */
export function gatherHelmSnapshot(now: Date = new Date()): HelmSnapshot {
    const nmea = (() => {
        try {
            return NmeaStore.getState() as unknown as Record<string, StoreMetric>;
        } catch (err) {
            log.warn('NMEA store unreadable', err);
            return {} as Record<string, StoreMetric>;
        }
    })();

    const depthUnit = (() => {
        try {
            return useSettingsStore.getState().settings.units?.length === 'ft' ? 'ft' : 'm';
        } catch {
            return 'm' as const;
        }
    })();

    const position = (() => {
        try {
            const fix = GpsService.getLastKnownPosition();
            return fix ? { latitude: fix.latitude, longitude: fix.longitude } : null;
        } catch (err) {
            log.warn('GPS unreadable', err);
            return null;
        }
    })();

    const anchor = (() => {
        try {
            const snap = AnchorWatchService.getSnapshot();
            const armed = snap.state === 'watching' || snap.state === 'alarm';
            return {
                armed,
                distanceM: Number.isFinite(snap.distanceFromAnchor) ? snap.distanceFromAnchor : null,
                radiusM: Number.isFinite(snap.swingRadius) ? snap.swingRadius : null,
                dragging: snap.state === 'alarm' && snap.alarmCause === 'drag',
            };
        } catch (err) {
            log.warn('anchor snapshot unreadable', err);
            return null;
        }
    })();

    // The barometer is the phone's own sensor, so it keeps working with no
    // link — which is exactly the point of asking for it out here.
    let pressureHpa: number | null = null;
    let pressureTrend3h: number | null = null;
    try {
        // Imported lazily: the barometer module registers a native listener on
        // load, and the helm path must not be the thing that starts it.
        const barometer = getBarometerModule();
        if (barometer) {
            pressureHpa = barometer.getLatestSample()?.hpa ?? null;
            const tendency = observedTendency(barometer.getStationSamples(), now.getTime());
            pressureTrend3h = tendency?.delta3h ?? null;
        }
    } catch (err) {
        log.warn('barometer unreadable', err);
    }

    return {
        depth: reading(nmea.depth),
        depthUnit,
        heading: reading(nmea.heading),
        cog: reading(nmea.cog),
        sog: reading(nmea.sog),
        tws: reading(nmea.tws),
        twd: reading(nmea.twd),
        aws: reading(nmea.aws),
        awa: reading(nmea.awa),
        waterTemp: reading(nmea.waterTemp),
        pressureHpa,
        pressureTrend3h,
        position,
        anchor,
        now,
    };
}

/**
 * The barometer module, if it has already been loaded by the Glass page.
 *
 * Deliberately does NOT import it — asking the depth should not spin up
 * pressure logging as a side effect. When the module isn't loaded the pressure
 * query simply reports no reading, which is honest.
 */
type BarometerModule = {
    getLatestSample: () => { hpa: number } | null;
    getStationSamples: () => { hpa: number; t: number }[];
};
let barometerModule: BarometerModule | null = null;
export function __setBarometerModuleForTests(mod: BarometerModule | null): void {
    barometerModule = mod;
}
function getBarometerModule(): BarometerModule | null {
    return barometerModule;
}
/** Called by the Glass page once it has started pressure logging. */
export function registerBarometerModule(mod: BarometerModule): void {
    barometerModule = mod;
}

/**
 * Speak through the OS synthesiser. No network, no ElevenLabs, no plugin.
 *
 * Apple's voice is plainer than Calypso's, and at the helm that is a feature —
 * it is instant, it always works, and nobody is being charmed while they are
 * steering.
 */
export function speakHelmAnswer(text: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
        // Cut off whatever is mid-sentence: a new question means the previous
        // answer is no longer the one wanted.
        speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        // Slightly brisk. These answers are three words long and the skipper
        // is busy.
        utterance.rate = 1.05;
        speechSynthesis.speak(utterance);
    } catch (err) {
        log.warn('native speech failed', err);
    }
}

export interface HelmResult {
    /** What was said, so the console can show it as a turn. */
    answer: string;
    query: string;
}

/**
 * Try to answer an utterance locally.
 *
 * Returns null when this is not a helm command — the caller then escalates to
 * Calypso, which is the right home for anything open-ended. Null is the common
 * case and is not a failure.
 */
export function tryHelmCommand(utterance: string, opts: { speak?: boolean } = {}): HelmResult | null {
    const intent = parseHelmCommand(utterance);
    if (!intent) return null;

    let answer: string;
    try {
        answer = answerHelmQuery(intent.query, gatherHelmSnapshot());
    } catch (err) {
        // A thrown formatter must not swallow the turn silently — the whole
        // point of this path is that failure is never mistaken for working.
        log.warn('helm answer failed', err);
        return null;
    }

    if (opts.speak !== false) speakHelmAnswer(answer);
    return { answer, query: intent.query };
}
