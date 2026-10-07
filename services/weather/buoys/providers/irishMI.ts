/**
 * Irish Weather Buoy Network — Marine Institute ERDDAP (build 123, W1-11).
 *
 * Dataset IWBNetwork (M2–M6, hourly). The app used to ask IMI-EATL-WAVE,
 * which answers 404, with a raw `>` that Tomcat rejects with a 400. This asks
 * for the newest row per station in the last 6 h, encoded. Measured
 * 2026-10-07: 200, CORS `*`, ~0.8 KB, M4 off station.
 *
 * ERDDAP answers 404 when no row matches (every buoy silent for 6 h): that
 * is "no buoys reporting", not an unreachable feed.
 *
 * QC_Flag is SeaDataNet: 0 unknown, 1 good, 9 missing; fills are -999.
 * Licence: CC BY 4.0, Marine Institute — credited as the owner.
 */
import { BuoyFeedError, getBuoyJson } from '../net';
import { reading } from '../qc';
import type { BuoyObs, BuoyProvider } from '../types';

export const IRISH_MI_URL =
    'https://erddap.marine.ie/erddap/tabledap/IWBNetwork.json' +
    '?station_id,longitude,latitude,time,WaveHeight,Tp,MeanWaveDirection,SeaTemperature,QC_Flag' +
    '&time%3E=now-6hours&orderByMax(%22station_id,time%22)';

interface ErddapTable {
    table?: { columnNames?: string[]; rows?: unknown[][] };
}

export function parseIrishMiErddap(json: unknown): BuoyObs[] {
    const table = (json as ErddapTable | null)?.table;
    if (!table?.columnNames || !Array.isArray(table.rows)) return [];
    const col = new Map(table.columnNames.map((name, i) => [name, i] as const));
    const out: BuoyObs[] = [];
    for (const row of table.rows) {
        const cell = (name: string): unknown => row[col.get(name) ?? -1];
        const id = cell('station_id');
        if (typeof id !== 'string' || !id || cell('QC_Flag') === 9) continue;
        const tp = reading(cell('Tp'));
        out.push({
            key: `irish-mi:${id}`,
            network: 'irish-mi',
            label: `${id} buoy`,
            owner: 'Marine Institute',
            lat: Number(cell('latitude') ?? NaN),
            lon: Number(cell('longitude') ?? NaN),
            time: Date.parse(String(cell('time'))),
            hsM: reading(cell('WaveHeight')),
            periodS: tp !== null && tp > 0 ? tp : null,
            fromDeg: reading(cell('MeanWaveDirection')),
            sstC: reading(cell('SeaTemperature')),
        });
    }
    return out;
}

export const irishMiProvider: BuoyProvider = {
    id: 'irish-mi',
    name: 'Marine Institute',
    nativeOnly: false,
    coverage: [[49, -18, 57, -3]],
    async fetchLatest() {
        let json: unknown;
        try {
            json = await getBuoyJson(IRISH_MI_URL, 'irish-mi-buoys');
        } catch (error) {
            if (error instanceof BuoyFeedError && error.status === 404) return [];
            throw error;
        }
        if (!(json as ErddapTable | null)?.table) throw new Error('irish-mi-buoys: no table');
        return parseIrishMiErddap(json);
    },
};
