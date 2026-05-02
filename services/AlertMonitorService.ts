/**
 * AlertMonitorService — Calypso's "speak up" engine.
 *
 * Subscribes to NmeaStore, evaluates the rule set on every state
 * change (new sample arriving, freshness watchdog tick), debounces
 * each violation, throttles re-fires by per-rule cooldowns, and
 * dispatches AlertEvents to AlertNotifier.
 *
 * The service is idle until the skipper enables it via
 * Settings → Calypso Integrations → Calypso alerts. When the toggle
 * is on AND the active subscription tier permits, App.tsx calls
 * `start()`; turning off (or losing tier eligibility) calls `stop()`.
 *
 * Why this lives in services/ rather than hooks/: alerts must keep
 * firing regardless of which page is mounted. Anchor watch follows
 * the same singleton-service pattern, and we want the alert system
 * to feel just as battle-hardened.
 */
import { NmeaStore, type NmeaStoreState } from './NmeaStore';
import type { AlertEvent, AlertRule, AlertThresholds } from '../types/alerts';
import { DEFAULT_ALERT_THRESHOLDS } from '../types/alerts';
import { dispatchAlert } from './AlertNotifier';

class AlertMonitorClass {
    private rules: AlertRule[] = [];
    private violationCounts = new Map<string, number>();
    private firstViolatingAt = new Map<string, number>();
    private lastFiredAt = new Map<string, number>();
    private unsubNmea: (() => void) | null = null;
    private running = false;
    private currentThresholds: Required<AlertThresholds> = { ...DEFAULT_ALERT_THRESHOLDS };

    /**
     * Start monitoring. Idempotent — calling start() while already
     * running is a no-op. Caller passes the user's threshold overrides
     * (or undefined for defaults). Ensures NmeaStore is running, since
     * an alert system that depends on telemetry must own its data
     * source: any other page that started NmeaStore for its own
     * reasons can't be relied on to keep it running.
     */
    start(thresholds?: AlertThresholds): void {
        if (this.running) {
            // Update thresholds in place — the skipper can dial them
            // without restarting the monitor.
            this.applyThresholds(thresholds);
            return;
        }
        this.running = true;
        this.applyThresholds(thresholds);

        // Make sure the data source is alive. start() is idempotent
        // on NmeaStore too.
        NmeaStore.start();

        this.unsubNmea = NmeaStore.subscribe((state) => this.evaluate(state));
        // Run an initial evaluation in case NmeaStore already had data.
        this.evaluate(NmeaStore.getState());
    }

    /** Stop monitoring. Doesn't stop NmeaStore — other pages may need it. */
    stop(): void {
        if (!this.running) return;
        this.running = false;
        if (this.unsubNmea) {
            this.unsubNmea();
            this.unsubNmea = null;
        }
        this.violationCounts.clear();
        this.firstViolatingAt.clear();
        this.lastFiredAt.clear();
    }

    isRunning(): boolean {
        return this.running;
    }

    /**
     * Test-only / debug: synthesise + dispatch an event without going
     * through the rule engine. Lets us wire a "Test alert" button into
     * the settings tab so the skipper can confirm Calypso speaks
     * before they're actually in danger.
     */
    fireTestAlert(): void {
        const now = Date.now();
        const event: AlertEvent = {
            ruleId: 'test-alert',
            severity: 'warn',
            title: 'Test alert',
            spokenMessage:
                'Skipper, this is Calypso testing the alert channel. If you can hear me, the speak-up system is wired correctly.',
            firstViolatingAt: now,
            firedAt: now,
        };
        void dispatchAlert(event);
    }

    // ── Internals ──────────────────────────────────────────────────

    private applyThresholds(t: AlertThresholds | undefined): void {
        this.currentThresholds = { ...DEFAULT_ALERT_THRESHOLDS, ...(t ?? {}) };
        this.rules = buildRules(this.currentThresholds);
    }

    private evaluate(state: NmeaStoreState): void {
        const now = Date.now();
        for (const rule of this.rules) {
            const violating = safeEvaluate(rule, state);

            if (violating) {
                const prevCount = this.violationCounts.get(rule.id) ?? 0;
                const next = prevCount + 1;
                this.violationCounts.set(rule.id, next);
                if (prevCount === 0) {
                    this.firstViolatingAt.set(rule.id, now);
                }
                const debounceN = rule.debounceN ?? 3;
                if (next < debounceN) continue;

                // Cooldown: don't spam the same alert. Two minutes default.
                const cooldownMs = (rule.cooldownSec ?? 120) * 1000;
                const last = this.lastFiredAt.get(rule.id) ?? 0;
                if (now - last < cooldownMs) continue;

                this.lastFiredAt.set(rule.id, now);
                const event: AlertEvent = {
                    ruleId: rule.id,
                    severity: rule.severity,
                    title: rule.title,
                    spokenMessage: safePhrase(rule, state),
                    firstViolatingAt: this.firstViolatingAt.get(rule.id) ?? now,
                    firedAt: now,
                };
                void dispatchAlert(event);
            } else {
                // Cleared — reset the streak so the next violation has
                // to re-debounce. Don't reset cooldown, so a flapping
                // condition can't go back to spam.
                if ((this.violationCounts.get(rule.id) ?? 0) > 0) {
                    this.violationCounts.set(rule.id, 0);
                    this.firstViolatingAt.delete(rule.id);
                }
            }
        }
    }
}

/** Rule evaluation is in user code → wrap in try/catch so a bad
 *  rule doesn't poison the whole monitor loop. */
function safeEvaluate(rule: AlertRule, state: NmeaStoreState): boolean {
    try {
        return rule.evaluate(state);
    } catch (err) {
        console.warn(`[AlertMonitor] rule ${rule.id} evaluate threw:`, err);
        return false;
    }
}
function safePhrase(rule: AlertRule, state: NmeaStoreState): string {
    try {
        return rule.phrase(state);
    } catch (err) {
        console.warn(`[AlertMonitor] rule ${rule.id} phrase threw:`, err);
        return `Skipper, ${rule.title}.`;
    }
}

/**
 * Construct the rule set. Closes over the user's thresholds so the
 * rules' threshold values are baked in at construction time — no
 * need to re-fetch settings on every evaluation.
 */
function buildRules(t: Required<AlertThresholds>): AlertRule[] {
    return [
        {
            id: 'battery-critical',
            description: 'Battery voltage critically low',
            severity: 'critical',
            title: 'Battery critical',
            evaluate: (s) => s.voltage.freshness === 'live' && (s.voltage.value ?? Infinity) < t.batteryCriticalV,
            phrase: (s) =>
                `Skipper, battery voltage critical: ${formatVolts(s.voltage.value)}. Reduce electrical load now.`,
            debounceN: 5, // ~5 seconds of bad readings before the alarm
            cooldownSec: 90,
        },
        {
            id: 'battery-warn',
            description: 'Battery voltage low',
            severity: 'warn',
            title: 'Battery low',
            evaluate: (s) => {
                if (s.voltage.freshness !== 'live') return false;
                const v = s.voltage.value;
                if (v === null) return false;
                // Don't double-fire with battery-critical — only warn
                // when below batteryWarnV but above batteryCriticalV.
                return v < t.batteryWarnV && v >= t.batteryCriticalV;
            },
            phrase: (s) => `Skipper, battery voltage low: ${formatVolts(s.voltage.value)}.`,
            debounceN: 5,
            cooldownSec: 600, // re-warn every 10 min
        },
        {
            id: 'battery-overcharge',
            description: 'Battery overcharging — possible alternator runaway',
            severity: 'critical',
            title: 'Alternator overcharge',
            evaluate: (s) => s.voltage.freshness === 'live' && (s.voltage.value ?? -Infinity) > t.batteryOverchargeV,
            phrase: (s) =>
                `Skipper, alternator overcharging: ${formatVolts(s.voltage.value)}. Check the regulator immediately.`,
            debounceN: 3,
            cooldownSec: 90,
        },
        {
            id: 'rpm-redline',
            description: 'Engine RPM above red-line',
            severity: 'warn',
            title: 'RPM red-line',
            evaluate: (s) => s.rpm.freshness === 'live' && (s.rpm.value ?? 0) > t.rpmRedlineMax,
            phrase: (s) => `Skipper, engine red-line, ${formatRpm(s.rpm.value)} RPM.`,
            debounceN: 3,
            cooldownSec: 120,
        },
        {
            id: 'depth-shoal',
            description: 'Depth below safe minimum while moving',
            severity: 'critical',
            title: 'Depth shoaling',
            evaluate: (s) => {
                if (s.depth.freshness !== 'live') return false;
                const d = s.depth.value;
                if (d === null) return false;
                // Only fire when actually moving — being moored in 2m
                // of water is fine; sailing into 2m is not.
                const sog = s.sog.freshness === 'live' ? (s.sog.value ?? 0) : 0;
                return d < t.depthShoalM && sog > 0.5;
            },
            phrase: (s) => `Skipper, depth ${formatDepth(s.depth.value)} metres. Watch the chart.`,
            debounceN: 3,
            cooldownSec: 60, // depth alerts can re-fire faster — danger is right now
        },
        {
            id: 'gps-quality',
            description: 'GPS signal degraded while underway',
            severity: 'warn',
            title: 'GPS degraded',
            evaluate: (s) => {
                // Only care while moving — at anchor, GPS quality is
                // expected to vary as boats swing.
                const sog = s.sog.freshness === 'live' ? (s.sog.value ?? 0) : 0;
                if (sog < 1.0) return false;
                const hdopBad = s.hdop.freshness === 'live' && (s.hdop.value ?? 0) > 5;
                const satsBad = s.satellites.freshness === 'live' && (s.satellites.value ?? 99) < 4;
                return hdopBad || satsBad;
            },
            phrase: (s) => {
                const hdop = s.hdop.value;
                const sats = s.satellites.value;
                if (sats !== null && sats < 4) {
                    return `Skipper, GPS signal degraded — only ${Math.round(sats)} satellites in view.`;
                }
                if (hdop !== null) {
                    return `Skipper, GPS signal degraded — accuracy compromised.`;
                }
                return 'Skipper, GPS signal degraded.';
            },
            debounceN: 10, // GPS flickers under bridges; need real persistence
            cooldownSec: 300,
        },
        {
            id: 'nmea-backbone-dead',
            description: 'NMEA backbone has stopped sending data',
            severity: 'warn',
            title: 'NMEA offline',
            evaluate: (s) => {
                // Only fire if we previously had data. lastAnyUpdate of
                // 0 means we never connected — that's a configuration
                // issue, not a runtime fault.
                if (s.lastAnyUpdate === 0) return false;
                return Date.now() - s.lastAnyUpdate > 60_000;
            },
            phrase: () => `Skipper, lost the NMEA backbone. Last data over a minute ago.`,
            debounceN: 3,
            cooldownSec: 600,
        },
    ];
}

// ── Number formatting ─────────────────────────────────────────────
//
// Why these helpers: ElevenLabs Flash v2.5 reads "12.3" as "twelve
// point three" reliably, but reads "11.4V" as "eleven point four V"
// (letter "V") rather than "volts". Our prepareForTTS edge-fn
// transformer handles this, but rule phrases avoid leaning on it for
// the most-common abbreviations.

function formatVolts(v: number | null): string {
    if (v === null) return 'unknown volts';
    return `${v.toFixed(1)} volts`;
}
function formatRpm(r: number | null): string {
    if (r === null) return 'unknown';
    return Math.round(r).toString();
}
function formatDepth(d: number | null): string {
    if (d === null) return 'unknown';
    return d.toFixed(1);
}

export const AlertMonitorService = new AlertMonitorClass();
