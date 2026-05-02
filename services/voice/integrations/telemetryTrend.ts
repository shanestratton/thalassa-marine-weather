/**
 * Telemetry trend tool — battery / RPM / depth drift over a window.
 *
 * Reads from TelemetryHistoryService (rolling 30-min ring buffer of
 * NMEA samples). Lets Calypso answer "is the battery normal?" /
 * "how's the depth been trending?" with actual data rather than a
 * single-point reading.
 *
 * Auto-starts the history service on first tool call so the buffer
 * starts filling without the user enabling anything explicit. The
 * service's memory footprint is small enough that running it
 * unconditionally is fine — and it's the prerequisite for ANY trend
 * narration, so making it lazy-start here is the cleanest path.
 */

import { TelemetryHistoryService } from '../../TelemetryHistoryService';
import { NmeaStore } from '../../NmeaStore';

type Metric = 'voltage' | 'rpm' | 'depth';

export async function telemetryTrend(
    metric: Metric,
    windowMin: number,
): Promise<{ content: string; isError: boolean }> {
    if (!['voltage', 'rpm', 'depth'].includes(metric)) {
        return { content: `ERROR: unknown metric '${metric}'`, isError: true };
    }

    // Lazy-start so the buffer is alive whenever a tool needs it.
    if (!TelemetryHistoryService.isRunning()) {
        TelemetryHistoryService.start();
    }

    const w = Math.max(1, Math.min(30, windowMin || 10));
    const summary = TelemetryHistoryService.summary(metric, w);
    const current = currentValue(metric);

    if (summary.samples === 0) {
        return {
            content: JSON.stringify({
                status: 'no_data',
                metric,
                current_value: current,
                note:
                    current === null
                        ? `No ${metric} data on the NMEA backbone right now. Tell the skipper plainly.`
                        : `Just opened the buffer — only the current reading. Check back in a few minutes for a trend, or wait for the next call.`,
            }),
            isError: false,
        };
    }

    const labels = {
        voltage: 'volts',
        rpm: 'RPM',
        depth: 'metres',
    } as const;
    const direction = directionLabel(metric, summary.delta ?? 0);
    return {
        content: JSON.stringify({
            status: 'trend',
            metric,
            window_min: w,
            samples: summary.samples,
            earliest: summary.earliest,
            latest: summary.latest ?? current,
            delta: Number((summary.delta ?? 0).toFixed(2)),
            unit: labels[metric],
            direction,
            note: `Read it naturally — "${metric} is ${direction}, ${summary.latest?.toFixed(2)} ${labels[metric]} now from ${summary.earliest?.toFixed(2)} ${w} minutes ago." Don't list every sample.`,
        }),
        isError: false,
    };
}

function currentValue(metric: Metric): number | null {
    const s = NmeaStore.getState();
    if (metric === 'voltage') return s.voltage.freshness === 'live' ? s.voltage.value : null;
    if (metric === 'rpm') return s.rpm.freshness === 'live' ? s.rpm.value : null;
    return s.depth.freshness === 'live' ? s.depth.value : null;
}

function directionLabel(metric: Metric, delta: number): string {
    // Threshold for "stable" varies by metric — voltage drift of
    // 0.05V is noise, 0.5V is real; depth drift of 0.1m is noise,
    // 1m is real.
    const noise = metric === 'voltage' ? 0.1 : metric === 'rpm' ? 30 : 0.3;
    if (Math.abs(delta) < noise) return 'stable';
    return delta > 0 ? 'climbing' : 'falling';
}
