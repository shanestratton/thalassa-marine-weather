/** Informational coarse receiver evidence. No target position, history or alarm API. */
import { fleetCoverageBounds, AIS_FLEET_FORWARDING as LIMIT } from '../../utils/aisFleetForwarding';
export type ReceiverCoverageState = 'off' | 'loading' | 'signed-out' | 'held' | 'available' | 'unavailable';
export interface ReceiverCoverageStatus {
    state: ReceiverCoverageState;
    partial: boolean;
    cells: number;
    asOf: number | null;
}
export interface ReceiverCoverageReply {
    schema: 1;
    state: 'held' | 'available';
    cells: string[];
    partial: boolean;
    asOf?: number;
    expiresAt?: number;
}
export function parseReceiverCoverage(value: unknown, now: number): ReceiverCoverageReply | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (
        v.schema !== 1 ||
        !['held', 'available'].includes(v.state as string) ||
        !Array.isArray(v.cells) ||
        v.cells.length > LIMIT.publicCells ||
        typeof v.partial !== 'boolean' ||
        v.cells.some((c) => !fleetCoverageBounds(c)) ||
        new Set(v.cells).size !== v.cells.length
    )
        return null;
    const held = v.state === 'held';
    if (
        Object.keys(v).sort().join(',') !==
        (held ? 'cells,partial,schema,state' : 'asOf,cells,expiresAt,partial,schema,state')
    )
        return null;
    if (held)
        return v.cells.length === 0 && !v.partial ? { schema: 1, state: 'held', cells: [], partial: false } : null;
    if (
        typeof v.asOf !== 'number' ||
        !Number.isSafeInteger(v.asOf) ||
        v.asOf % 300000 !== 0 ||
        v.asOf > now - LIMIT.publicDelayMs + 1000 ||
        now - v.asOf > 11 * 60000 ||
        typeof v.expiresAt !== 'number' ||
        !Number.isSafeInteger(v.expiresAt) ||
        v.expiresAt <= now ||
        v.expiresAt > now + 65000
    )
        return null;
    return {
        schema: 1,
        state: 'available',
        cells: [...v.cells] as string[],
        partial: v.partial,
        asOf: v.asOf,
        expiresAt: v.expiresAt,
    };
}
export function receiverCoverageFeatures(reply: ReceiverCoverageReply): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
    return {
        type: 'FeatureCollection',
        features:
            reply.state === 'available'
                ? reply.cells.flatMap((id) => {
                      const b = fleetCoverageBounds(id);
                      if (!b) return [];
                      const [w, s, e, n] = b;
                      return [
                          {
                              type: 'Feature' as const,
                              properties: { cell: id },
                              geometry: {
                                  type: 'Polygon' as const,
                                  coordinates: [
                                      [
                                          [w, s],
                                          [e, s],
                                          [e, n],
                                          [w, n],
                                          [w, s],
                                      ],
                                  ],
                              },
                          },
                      ];
                  })
                : [],
    };
}
export function receiverCoverageWords(status: ReceiverCoverageStatus): string {
    if (status.state === 'off') return 'Receiver coverage off.';
    if (status.state === 'loading') return 'Checking recent receiver coverage…';
    if (status.state === 'signed-out') return 'Sign in to view coarse receiver coverage.';
    if (status.state === 'held')
        return 'Receiver coverage is held until its service and display prerequisites are ready.';
    if (status.state === 'unavailable')
        return 'Receiver coverage unavailable; an empty map does not mean nobody is listening.';
    return `${status.partial ? 'Partial recent' : 'Recent'} listening cells · delayed, coarse evidence from at least three consenting accounts and receivers. ${status.cells === 0 ? 'No qualifying cells in this view. ' : ''}Reception of any particular vessel is not assured.`;
}
export function receiverCoverageWindow(bounds: {
    getWest(): number;
    getSouth(): number;
    getEast(): number;
    getNorth(): number;
}): [number, number, number, number] | null {
    const raw = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    if (raw.some((v) => !Number.isFinite(v))) return null;
    const [west, south, east, north] = raw;
    const s = Math.max(-90, south),
        n = Math.min(90, north);
    if (s >= n) return null;
    const wrap = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;
    return east - west >= 360 ? [-180, s, 180, n] : [wrap(west), s, wrap(east), n];
}
