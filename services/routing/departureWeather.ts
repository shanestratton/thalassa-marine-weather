import { fetchOpenMeteoPoints } from '../weather/openMeteoProxy';
import { haversineNm } from '../isochrone/geodesy';

export interface DepartureWeatherSample {
    windSpeedKts: number | null;
    windDirection: number | null;
    gustKts: number | null;
    rainMmPerHour: number | null;
}
export interface DepartureWeatherField {
    model: string;
    getWeather(lat: number, lon: number, atMs: number): DepartureWeatherSample | null;
}
interface Row {
    hourly?: {
        [key: string]: unknown[] | undefined;
        time?: number[];
        wind_speed_10m?: unknown[];
        wind_direction_10m?: unknown[];
        wind_gusts_10m?: unknown[];
        precipitation?: unknown[];
    };
}
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** One named-model batch. Missing nearest cells and missing hourly brackets remain unknown. */
export async function loadDepartureWeather(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    satelliteMode = false,
): Promise<DepartureWeatherField | null> {
    if (satelliteMode || Math.abs(origin.lon - destination.lon) > 180) return null;
    const south = Math.max(-90, Math.min(origin.lat, destination.lat) - 1);
    const north = Math.min(90, Math.max(origin.lat, destination.lat) + 1);
    const west = Math.max(-180, Math.min(origin.lon, destination.lon) - 1);
    const east = Math.min(180, Math.max(origin.lon, destination.lon) + 1);
    const points = Array.from({ length: 25 }, (_, i) => ({
        lat: south + (Math.floor(i / 5) * (north - south)) / 4,
        lon: west + ((i % 5) * (east - west)) / 4,
    }));
    let rows: Row[];
    try {
        rows = await fetchOpenMeteoPoints<Row>('forecast', points, {
            hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation',
            models: 'gfs_seamless',
            wind_speed_unit: 'kn',
            timeformat: 'unixtime',
            forecast_hours: 170,
        });
    } catch {
        return null;
    }
    if (rows.length !== points.length) return null;
    return {
        model: 'GFS',
        getWeather(lat, lon, atMs) {
            if (!Number.isFinite(atMs) || lat < south || lat > north || lon < west || lon > east) return null;
            let nearest = -1,
                distance = Infinity;
            for (let i = 0; i < points.length; i++) {
                const nm = haversineNm(lat, lon, points[i].lat, points[i].lon);
                if (nm < distance) {
                    nearest = i;
                    distance = nm;
                }
            }
            if (distance > 150) return null;
            const h = rows[nearest]?.hourly,
                times = h?.time;
            const values = (key: string) => h?.[key] ?? h?.[`${key}_gfs_seamless`];
            if (!times?.length || times.some((t, i) => !Number.isFinite(t) || (i > 0 && t - times[i - 1] !== 3600)))
                return null;
            const seconds = atMs / 1000;
            if (seconds < times[0] || seconds > times.at(-1)!) return null;
            const hi = times.findIndex((t) => t >= seconds);
            const lo = times[hi] === seconds ? hi : hi - 1;
            const fraction = hi === lo ? 0 : (seconds - times[lo]) / (times[hi] - times[lo]);
            const interpolate = (values: unknown[] | undefined, direction = false) => {
                const a = number(values?.[lo]),
                    b = number(values?.[hi]);
                if (a === null || b === null) return null;
                return direction ? (a + (((b - a + 540) % 360) - 180) * fraction + 360) % 360 : a + (b - a) * fraction;
            };
            return {
                windSpeedKts: interpolate(values('wind_speed_10m')),
                windDirection: interpolate(values('wind_direction_10m'), true),
                gustKts: interpolate(values('wind_gusts_10m')),
                rainMmPerHour: number(values('precipitation')?.[hi]),
            };
        },
    };
}
