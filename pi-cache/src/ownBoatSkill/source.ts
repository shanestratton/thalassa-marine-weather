import { createHash } from 'node:crypto';
import { readWeatherPositionLeaf } from '../weatherPosition.js';
import { readWindHistorySample } from '../windHistory.js';
import { ownBoatCell, ownBoatRecord } from '../ownBoatSkillWire.js';
export interface OwnInstrumentSource {
    selfKey: string;
    windSourceKey: string;
    positionSourceKey: string;
    windSource: string;
    positionSource: string;
    sample: { at: number; receivedAt: number; positionAt: number; cell: string; windMps: number; rawWind: string };
}
/** The pure sample contract must not pull the SQLite ledger into app checks. */
export type PrivateWindSample = OwnInstrumentSource['sample'];
/** Exact dated true-wind and position leaves only; no parent clocks, held fix or apparent wind. */
export function readOwnInstrumentSource(document: unknown, now: number): OwnInstrumentSource | null {
    const position = readWeatherPositionLeaf(document, now),
        wind = readWindHistorySample(document, now);
    if (!position || !wind) return null;
    const cell = ownBoatCell(position.position.lat, position.position.lon);
    if (
        !cell ||
        !ownBoatRecord(document) ||
        !ownBoatRecord(document.environment) ||
        !ownBoatRecord(document.environment.wind) ||
        !ownBoatRecord(document.environment.wind.speedTrue) ||
        !ownBoatRecord(document.navigation) ||
        !ownBoatRecord(document.navigation.position)
    )
        return null;
    const mps = document.environment.wind.speedTrue.value;
    if (typeof mps !== 'number' || !Number.isFinite(mps)) return null;
    return {
        selfKey: position.selfKey,
        windSourceKey: createHash('sha256')
            .update(JSON.stringify([1, position.selfKey, 'environment.wind.speedTrue', wind.source]))
            .digest('hex'),
        positionSourceKey: position.sourceKey,
        windSource: wind.source,
        positionSource: String(document.navigation.position.$source),
        sample: {
            at: wind.at,
            receivedAt: now,
            positionAt: position.position.at,
            cell,
            windMps: mps,
            rawWind: JSON.stringify({
                value: mps,
                timestamp: document.environment.wind.speedTrue.timestamp,
                $source: document.environment.wind.speedTrue.$source,
            }),
        },
    };
}
