/**
 * types/alerts.ts — Calypso proactive-alert types.
 *
 * The "speak up" feature: an always-on monitor service subscribes to
 * NmeaStore + (later) Victron + bilge sensors, runs a rules engine,
 * and fires AlertEvents when something looks wrong. AlertNotifier
 * routes the event to:
 *   - chime via AlarmAudioService (full-volume, mute-bypassed)
 *   - Calypso voice (ElevenLabs TTS via the standalone ttsClient)
 *   - voice console takeover (dispatches a 'thalassa:navigate' event
 *     to setPage('voice') so the alert lands on the front page)
 *   - voice history turn so the alert is visible in the conversation log
 *
 * Severity tiers mirror standard maritime alarm convention:
 *   - critical: imminent danger (low battery, depth shoaling, RPM redline,
 *               alternator runaway). Chime + voice + foreground takeover.
 *   - warn:     attention needed but not immediate (NMEA backbone dead,
 *               GPS quality degraded, RPM at zero while underway).
 *               Voice + voice-history turn, no chime.
 *   - info:     transient or status (backbone reconnected, GPS recovered).
 *               Voice-history turn only, optional voice on user setting.
 *               (Reserved — V1 doesn't fire `info` events.)
 */

import type { NmeaStoreState } from '../services/NmeaStore';

export type AlertSeverity = 'critical' | 'warn' | 'info';

/** A discrete alert moment — one rule violating, one phrase, one fire. */
export interface AlertEvent {
    /** Stable identifier for de-dupe / cooldown / re-fire suppression. */
    ruleId: string;
    severity: AlertSeverity;
    /** Calypso's phrasing — already number-spelled-out and TTS-ready. */
    spokenMessage: string;
    /** Short label for the in-app banner / voice history turn. */
    title: string;
    /** Epoch ms when the rule first started violating (NOT when it fired). */
    firstViolatingAt: number;
    /** Epoch ms when this event was dispatched. */
    firedAt: number;
}

/**
 * A single rule the monitor evaluates on every NmeaStore tick. Rules
 * are pure functions — they never mutate state, never fire side
 * effects, only describe their violation condition + phrasing.
 *
 * The monitor adds debounce + cooldown around them, so flapping
 * voltage at the threshold doesn't trigger a Calypso interruption
 * every tick.
 */
export interface AlertRule {
    /** Stable ID for cooldown bookkeeping. Don't change after release —
     *  changing it resets the per-rule re-fire timer. */
    id: string;
    /** One-line description shown in dev tools / debug. */
    description: string;
    severity: AlertSeverity;
    /** Short label, used as the title on the in-app banner.
     *  e.g. "Battery low", "Depth shoaling", "RPM red-line". */
    title: string;
    /**
     * True when the rule is currently violated. Pure — no side effects.
     * Receives the full NmeaStore snapshot so the rule can correlate
     * (e.g. "RPM at zero is only a problem when SOG > 2 kts").
     */
    evaluate: (state: NmeaStoreState) => boolean;
    /**
     * Calypso's spoken phrase when this rule fires. Receives the
     * snapshot so the message can quote live values.
     * Numbers should be written in TTS-friendly form (e.g.
     * "eleven point three volts" not "11.3V") — the elevenlabs-tts
     * edge function applies prepareForTTS normalisation but rule
     * phrases avoid leaning on it for known-tricky tokens.
     */
    phrase: (state: NmeaStoreState) => string;
    /**
     * Min consecutive violating samples before firing. Each NmeaStore
     * tick is roughly 1s (watchdog) or whenever new NMEA data arrives.
     * Default: 3 (don't trigger on a single noisy reading).
     */
    debounceN?: number;
    /**
     * Min seconds between repeat firings of this same rule. Prevents
     * Calypso re-announcing a sustained low-voltage condition every
     * second. Default: 120 (2 minutes).
     */
    cooldownSec?: number;
}

/**
 * User-tunable thresholds for the rules. Persisted in UserSettings so
 * the skipper can dial in numbers for their specific vessel (battery
 * chemistry varies — LiFePO4 nominal range is way different from
 * lead-acid; engine red-line varies by powerplant).
 *
 * V1 ships with a single on/off toggle and these defaults; per-rule
 * UI lands in a follow-up if the skipper wants more control.
 */
export interface AlertThresholds {
    /** Below this voltage → warn. Default 12.0V (lead-acid 50% SOC). */
    batteryWarnV?: number;
    /** Below this voltage → critical. Default 11.5V (lead-acid danger). */
    batteryCriticalV?: number;
    /** Above this voltage → critical (alternator runaway). Default 14.6V. */
    batteryOverchargeV?: number;
    /** Above this RPM → warn (red-line). Default 2400 (Perkins-class). */
    rpmRedlineMax?: number;
    /** Below this depth (m) while moving → critical. Default 3.0m. */
    depthShoalM?: number;
}

export const DEFAULT_ALERT_THRESHOLDS: Required<AlertThresholds> = {
    batteryWarnV: 12.0,
    batteryCriticalV: 11.5,
    batteryOverchargeV: 14.6,
    rpmRedlineMax: 2400,
    depthShoalM: 3.0,
};
