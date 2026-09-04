/**
 * The clock's voice — a struck bell, synthesised.
 *
 * Shane 2026-09-04: "we need the bells to work on the clock claude. at the
 * moment they dont???" They didn't: the face showed which bell it was and
 * never made a sound, because striking was never built.
 *
 * SYNTHESISED, not sampled. A ship's bell is a struck metal body, which is a
 * set of INHARMONIC partials decaying at different rates — the reason a bell
 * reads as a bell and not as a beep is that its overtones are not whole
 * multiples of the fundamental and the high ones die first. That is a dozen
 * lines of Web Audio, ships no binary asset, needs no licence, and works with
 * no signal at anchor. If it ever sounds thin we can swap a recording in
 * behind `strike()` without touching the striking logic above it.
 *
 * IT WILL NOT PLAY OVER AN ALARM. AlarmAudioService hands out leases precisely
 * so "a short Calypso chime can never silence an active Anchor Watch alarm",
 * and a clock that chimes over a drag alarm would be a dangerous cute feature.
 */
import { AlarmAudioService } from './AlarmAudioService';
import { bellPattern } from '../utils/shipsBells';
import { createLogger } from '../utils/createLogger';

const log = createLogger('ShipsBellChime');

/**
 * Ratios of a struck bell, with the minor third that gives it its voice.
 * Each partial decays at its own rate — the bright ones fastest, the hum last.
 */
const PARTIALS: Array<{ ratio: number; gain: number; decay: number }> = [
    { ratio: 0.56, gain: 0.32, decay: 1.9 }, // hum — the tail you hear after
    { ratio: 1.0, gain: 1.0, decay: 1.5 }, // prime
    { ratio: 1.19, gain: 0.55, decay: 1.1 }, // minor third
    { ratio: 1.51, gain: 0.4, decay: 0.85 }, // fifth
    { ratio: 2.0, gain: 0.3, decay: 0.7 }, // nominal
    { ratio: 2.66, gain: 0.18, decay: 0.45 },
    { ratio: 3.01, gain: 0.12, decay: 0.35 },
];

/** Small bell, so a high fundamental. A ship's bell is bright, not a church. */
const FUNDAMENTAL_HZ = 1180;
/** Within a pair: ding-ding. */
const PAIR_GAP_S = 0.26;
/** Between pairs, so a listener can count them. */
const GROUP_GAP_S = 0.78;

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
    try {
        if (!ctx) {
            const Ctor =
                window.AudioContext ??
                (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctor) return null;
            ctx = new Ctor();
        }
        return ctx;
    } catch {
        return null;
    }
}

/** One strike of the bell at `at` seconds on the context clock. */
function strikeOnce(c: AudioContext, at: number, volume: number): void {
    for (const p of PARTIALS) {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = FUNDAMENTAL_HZ * p.ratio;
        // Exponential decay: a struck body loses energy fastest at the start,
        // which is what a linear ramp gets wrong and why it sounds synthetic.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(p.gain * volume, at + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + p.decay);
        osc.connect(gain).connect(c.destination);
        osc.start(at);
        osc.stop(at + p.decay + 0.05);
    }
}

export const ShipsBellChime = {
    /** iOS starts every context suspended; call this from a real tap. */
    async unlock(): Promise<void> {
        const c = audio();
        if (c && c.state === 'suspended') {
            try {
                await c.resume();
            } catch {
                /* the next tap will try again */
            }
        }
    },

    /**
     * Strike `bells` in pairs, the way a bell is actually rung and counted.
     *
     * Refuses while an alarm is sounding — see the header. Returns false when
     * nothing was played, so a caller can tell silence from success.
     */
    strike(bells: number, volume = 0.25): boolean {
        if (AlarmAudioService.getIsPlaying()) {
            log.warn('Not striking: an alarm is sounding and must not be talked over');
            return false;
        }
        const c = audio();
        if (!c || c.state !== 'running') return false;
        let at = c.currentTime + 0.05;
        for (const group of bellPattern(bells)) {
            for (let i = 0; i < group; i++) {
                strikeOnce(c, at, volume);
                at += PAIR_GAP_S;
            }
            at += GROUP_GAP_S - PAIR_GAP_S;
        }
        return true;
    },
};
