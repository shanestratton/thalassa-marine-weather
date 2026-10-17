import type { computeIsochrones } from '../IsochroneRouter';
import { inspectRouteEnvironment } from './routeComfort';

/** At most two explicitly labelled wave-only relaxations; wind/gust caps stay. */
export async function runComfortAttempts(
    compute: typeof computeIsochrones,
    ...args: Parameters<typeof computeIsochrones>
): ReturnType<typeof computeIsochrones> {
    const config = args[5] ?? {};
    const limit = config.comfortParams?.maxWaveM;
    const started = performance.now();
    const current = () => performance.now() - started < 60_000 && (config.shouldContinue?.() ?? true);
    const limits =
        typeof limit === 'number' && Number.isFinite(limit) && limit > 0
            ? [
                  limit,
                  ...[1.15, 1.3]
                      .map((f) => Math.min(limit * f, config.waveLimitCeilingM ?? Infinity))
                      .filter((n) => n > limit),
              ]
            : [undefined];
    for (const waveLimit of [...new Set(limits)]) {
        if (!current()) return null;
        const result = await compute(
            ...([
                ...args.slice(0, 5),
                {
                    ...config,
                    shouldContinue: current,
                    comfortParams:
                        waveLimit === undefined
                            ? config.comfortParams
                            : { ...config.comfortParams, maxWaveM: waveLimit },
                },
                ...args.slice(6),
            ] as Parameters<typeof computeIsochrones>),
        );
        if (!current()) return null;
        if (result) {
            const checked = inspectRouteEnvironment(result.route, args[9], args[8], waveLimit, config.comfortVessel);
            if (checked.rejected) continue;
            result.comfort = checked.comfort;
            if (waveLimit !== undefined && waveLimit !== limit && result.comfort)
                result.comfort = { ...result.comfort, relaxedFromM: limit, usedLimitM: waveLimit };
            return result;
        }
    }
    return null;
}
