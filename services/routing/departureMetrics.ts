import type { CurrentField, IsochroneNode, WaveField, ExclusionField, WindField } from '../isochrone/types';
import { calcTWA, haversineNm, initialBearing, projectPosition } from '../isochrone/geodesy';
import { inspectRouteEnvironment } from '../isochrone/routeComfort';
import type { DepartureWeatherField } from './departureWeather';
import type { VesselProfile } from '../../types';
import type { ComfortPreference } from '../../utils/comfortPreference';

/** Sample the displayed path on its own clock, including conditions between its smoothed nodes. */
export function departureMetrics(
    route: readonly IsochroneNode[],
    departureMs: number,
    wind: WindField,
    currents: CurrentField | null,
    waves: WaveField | null,
    exclusions: ExclusionField | null,
    weather: DepartureWeatherField | null | undefined,
    vessel: VesselProfile,
    maxWaveM?: number,
    preference?: ComfortPreference | null,
) {
    let hours = 0,
        knownWindHours = 0,
        windSum = 0,
        maxWindKts = 0,
        galeHours = 0,
        stormHours = 0;
    let upwindHours = 0,
        maxHeadwindKts = 0,
        maxGustKts = 0,
        maxRainMmPerHour = 0;
    let currentSum = 0,
        adverseCurrentKts = 0,
        count = 0;
    let gustComplete = true,
        rainComplete = true,
        currentComplete = true;
    const inspected = inspectRouteEnvironment(route, waves, exclusions, maxWaveM, vessel, preference);
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1],
            b = route[i];
        const dt = b.timeHours - a.timeHours;
        const distance = haversineNm(a.lat, a.lon, b.lat, b.lon);
        if (!(dt > 0) || !Number.isFinite(distance)) continue;
        const n = Math.max(1, Math.ceil(dt), Math.ceil(distance / 5));
        if (count + n > 2048) {
            gustComplete = rainComplete = currentComplete = false;
            break;
        }
        count += n;
        const bearing = initialBearing(a.lat, a.lon, b.lat, b.lon);
        for (let j = 0; j < n; j++) {
            const fraction = (j + 0.5) / n;
            const point = projectPosition(a.lat, a.lon, bearing, distance * fraction);
            const t = a.timeHours + dt * fraction,
                weight = dt / n;
            hours += weight;
            const w = wind.getWind?.(point.lat, point.lon, t);
            if (w && Number.isFinite(w.speed) && Number.isFinite(w.direction) && w.speed >= 0) {
                knownWindHours += weight;
                windSum += w.speed * weight;
                maxWindKts = Math.max(maxWindKts, w.speed);
                if (w.speed >= 34) galeHours += weight;
                if (w.speed >= 48) stormHours += weight;
                const angle = calcTWA(bearing, w.direction);
                if (angle < 50) upwindHours += weight;
                maxHeadwindKts = Math.max(maxHeadwindKts, w.speed * Math.cos((angle * Math.PI) / 180));
            }
            const forecast = weather?.getWeather(point.lat, point.lon, departureMs + t * 3_600_000);
            if (forecast?.gustKts == null) gustComplete = false;
            else maxGustKts = Math.max(maxGustKts, forecast.gustKts);
            if (forecast?.rainMmPerHour == null) rainComplete = false;
            else maxRainMmPerHour = Math.max(maxRainMmPerHour, forecast.rainMmPerHour);
            const c = currents?.getCurrent(point.lat, point.lon, t);
            if (!c || !Number.isFinite(c.speed) || !Number.isFinite(c.direction)) currentComplete = false;
            else {
                const along = c.speed * Math.cos(((c.direction - bearing) * Math.PI) / 180);
                currentSum += along * weight;
                adverseCurrentKts = Math.max(adverseCurrentKts, -along);
            }
        }
    }
    const totalHours = route.length > 1 ? route.at(-1)!.timeHours - route[0].timeHours : 0;
    const windComplete =
        hours > 0 && hours >= totalHours - 1e-6 && knownWindHours >= hours - 1e-6 && !inspected.rejected;
    return {
        maxWindKts,
        avgWindKts: knownWindHours ? windSum / knownWindHours : 0,
        galeHours,
        stormHours,
        windComplete,
        maxHeadwindKts,
        maxGustKts,
        gustComplete: hours > 0 && gustComplete,
        maxRainMmPerHour: hours && rainComplete ? maxRainMmPerHour : null,
        rainComplete: hours > 0 && rainComplete,
        upwindPct: windComplete ? (100 * upwindHours) / hours : null,
        upwindComplete: windComplete,
        avgCurrentKts: hours && currentComplete ? currentSum / hours : null,
        adverseCurrentKts: hours && currentComplete ? adverseCurrentKts : null,
        currentComplete: hours > 0 && currentComplete,
        maxWaveM: inspected.comfort.maxWaveM,
        waveComplete: inspected.comfort.coverage === 'complete',
        comfortLevel: inspected.comfort.level,
        comfortComplete: inspected.comfort.coverage === 'complete' && inspected.comfort.level !== null,
        comfort: inspected.comfort,
        rejected: inspected.rejected,
    };
}
