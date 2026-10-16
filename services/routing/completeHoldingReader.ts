import { readHoldingChart, type HoldingChartRead } from '../enc/readHoldingChart';
import { readHoldingEnvironment, type HoldingEnvironmentRead } from '../weather/readHoldingEnvironment';
import type { CompleteHoldingFacts, TideWaitRequest } from './tideWaitReview';
export interface HoldingEvidence {
    chart: HoldingChartRead;
    environment: HoldingEnvironmentRead;
}
export interface DetailedHoldingFacts extends CompleteHoldingFacts {
    aboardOnly: boolean;
    evidence: HoldingEvidence;
}
/** Current chart/forecast read is concrete even when independent tide rights,
 * station transfer, permission, source clocks or local exposure are absent. */
export async function readCompleteHoldingFacts(
    request: TideWaitRequest,
    incoming: { lat: number; lon: number } | null,
    options: { signal: AbortSignal; assertCurrent: () => void },
): Promise<DetailedHoldingFacts> {
    const controller = new AbortController(),
        abort = () => controller.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30000);
    let stopped: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
        stopped = () => reject(new DOMException('Holding evidence read stopped or exceeded 30 seconds.', 'AbortError'));
        controller.signal.addEventListener('abort', stopped, { once: true });
    });
    if (options.signal.aborted) abort();
    try {
        return await Promise.race([
            readCurrentHoldingFacts(request, incoming, {
                signal: controller.signal,
                assertCurrent: options.assertCurrent,
            }),
            timeout,
        ]);
    } finally {
        clearTimeout(timer);
        controller.abort();
        options.signal.removeEventListener('abort', abort);
        if (stopped) controller.signal.removeEventListener('abort', stopped);
    }
}
async function readCurrentHoldingFacts(
    request: TideWaitRequest,
    incoming: { lat: number; lon: number } | null,
    options: { signal: AbortSignal; assertCurrent: () => void },
): Promise<DetailedHoldingFacts> {
    options.signal.throwIfAborted();
    options.assertCurrent();
    const chart = await readHoldingChart(request, incoming, request.radiusM, options);
    options.signal.throwIfAborted();
    options.assertCurrent();
    const readAtMs = Date.now();
    const check = () => {
        options.signal.throwIfAborted();
        options.assertCurrent();
    };
    const environment = readHoldingEnvironment(chart.bounds, request.fromMs, request.untilMs, readAtMs, check);
    const fields = [environment.wind, environment.gust, environment.waves, environment.currents];
    // Publication/receipt/valid-start clocks are never substituted for issue.
    const issues = fields.map((f) => f.originalIssueMs);
    const weather: CompleteHoldingFacts['weather'] = issues.every((v): v is number => v !== null && Number.isFinite(v))
        ? {
              source: fields.map((f) => f.source).join('; '),
              originalIssueMs: Math.min(...issues),
              expiresAtMs: Math.min(readAtMs + 300000, ...fields.map((f) => f.validUntilMs ?? -Infinity)),
              maxIssueAgeMs: 12 * 3600000,
              fromMs: request.fromMs,
              untilMs: request.untilMs,
              completeIntervalAndExposure:
                  fields.every(
                      (f) => f.completeAreaAndInterval && f.originalIssueMs !== null && f.originalIssueMs <= readAtMs,
                  ) && environment.completeLocalExposure,
              maxWindKts: environment.wind.maximum,
              maxGustKts: environment.gust.maximum,
              maxWaveM: environment.waves.maximum,
              maxCurrentKts: environment.currents.maximum,
              includesTidalStreams: environment.includesTidalStreams,
          }
        : null;
    check();
    return {
        lifetimeKey: request.lifetimeKey,
        chartContentKey: chart.chartContentKey,
        lat: request.lat,
        lon: request.lon,
        radiusM: request.radiusM,
        readAtMs,
        completeCircleAndApproach: chart.completeCircleAndApproach,
        minimumChartedDepthM: chart.minimumChartedDepthM,
        datumId: chart.datumId,
        datumEpoch: chart.datumEpoch,
        hazards: chart.hazards,
        permission: chart.permission,
        bottom: chart.bottom,
        bottomIsPointSample: false,
        weather,
        aboardOnly: chart.aboardOnly,
        evidence: { chart, environment },
    };
}
