/** Bounded chart query inside the chart-vault process only. Nothing returned
 * across IPC identifies a cell, geometry, depth or tide value. */
import { EncSpatialIndex } from '../lookaheadShared/services/enc/EncSpatialIndex.js';
import { buildHazardsForCell, buildCoastlines } from '../lookaheadShared/services/enc/encHazardParse.js';
import { cellSoundingDatum } from '../lookaheadShared/services/enc/chartDatum.js';
import type { EncConversionResult } from '../lookaheadShared/services/enc/types.js';
import {
    aheadCone,
    aheadBounds,
    aheadGeometryWithinLimit,
    scanAhead,
    type AheadHazard,
} from '../lookaheadShared/services/underway/lookaheadRule.js';
import { coneIsCovered } from '../lookaheadShared/services/underway/lookaheadCoverage.js';
import type { VaultCellMeta, VaultLookaheadRequest, VaultLookaheadResponse } from './protocol.js';

export function validLookaheadRequest(raw: unknown, now = Date.now()): raw is VaultLookaheadRequest {
    const q = raw as VaultLookaheadRequest | null;
    if (!q || typeof q !== 'object' || !q.fix) return false;
    const f = q.fix;
    if (
        ![f.lat, f.lon, f.at, f.sogKn, f.cogDeg, q.draftM, q.ukcM, q.windowMin].every(Number.isFinite) ||
        Math.abs(f.lat) > 85 ||
        Math.abs(f.lon) > 180 ||
        f.sogKn <= 0.5 ||
        f.sogKn > 100 ||
        f.at - now > 5000 ||
        now - f.at > 30_000 ||
        q.draftM <= 0 ||
        q.draftM > 20 ||
        q.ukcM < 0.5 ||
        q.ukcM > 3 ||
        q.windowMin < 5 ||
        q.windowMin > 15 ||
        typeof q.onLine !== 'boolean'
    )
        return false;
    if (q.tide !== undefined) {
        const t = q.tide;
        if (
            !t ||
            t.datum !== 'LAT' ||
            !Number.isFinite(t.expires) ||
            t.expires < now ||
            t.expires > now + 6 * 3600_000 ||
            !Array.isArray(t.points) ||
            t.points.length < 2 ||
            t.points.length > 64 ||
            !t.points.every(
                (p, i) =>
                    p &&
                    Number.isFinite(p.dt) &&
                    Number.isFinite(p.height) &&
                    Math.abs(p.height) <= 30 &&
                    (i === 0 || p.dt > t.points[i - 1].dt),
            )
        )
            return false;
    }
    return true;
}

/** Linear curve supplied from the Pi's existing cache. No curve or missing
 * range gives no positive credit, and only a matching cell may use it. */
function tideAt(q: VaultLookaheadRequest, at: number): number | null {
    const t = q.tide;
    if (!t || Date.now() > t.expires) return null;
    const seconds = at / 1000;
    for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1],
            b = t.points[i];
        if (seconds >= a.dt && seconds <= b.dt)
            return a.height + ((b.height - a.height) * (seconds - a.dt)) / (b.dt - a.dt);
    }
    return null;
}

export class VaultLookahead {
    private readonly cache = new Map<string, { sha256: string; index: EncSpatialIndex; datum: string | null }>();
    private busy = false;
    async query(
        q: VaultLookaheadRequest,
        cells: readonly VaultCellMeta[],
        read: (id: string) => Promise<{ bytes: Buffer; sha256: string }>,
    ): Promise<VaultLookaheadResponse> {
        if (this.busy || !validLookaheadRequest(q)) return { coverage: 'unavailable', danger: false };
        const cone = aheadCone(q.fix, q.windowMin, q.onLine);
        if (!cone) return { coverage: 'unavailable', danger: false };
        this.busy = true;
        const deadline = Date.now() + 2000;
        let loaded = 0,
            danger = false;
        const all: AheadHazard[] = [];
        try {
            const boxes = aheadBounds(cone);
            const relevant = cells.filter((c) =>
                boxes.some(
                    ([w, s, e, n]) =>
                        c.bbox[3] >= s &&
                        c.bbox[1] <= n &&
                        (c.bbox[0] <= c.bbox[2] ? c.bbox[2] >= w && c.bbox[0] <= e : c.bbox[2] >= w || c.bbox[0] <= e),
                ),
            );
            for (const cell of relevant.slice(0, 8)) {
                if (Date.now() > deadline) return { coverage: 'partial', danger };
                let held = this.cache.get(cell.cellId);
                if (held?.sha256 !== cell.contentSha256) {
                    const got = await read(cell.cellId).catch(() => null);
                    if (
                        !got ||
                        got.sha256 !== cell.contentSha256 ||
                        got.bytes.length > 32 * 1024 * 1024 ||
                        Date.now() > deadline
                    )
                        continue;
                    const parsed = JSON.parse(got.bytes.toString('utf8')) as { cells?: EncConversionResult[] };
                    const blob = parsed.cells?.find((c) => c.cellId === cell.cellId);
                    if (!blob?.layers) continue;
                    held = {
                        sha256: got.sha256,
                        index: new EncSpatialIndex(cell.cellId, buildHazardsForCell(blob), [], buildCoastlines(blob)),
                        datum: cellSoundingDatum(blob),
                    };
                    this.cache.set(cell.cellId, held);
                    while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value!);
                }
                if (!held) continue;
                const hazards = held.index.lookaheadCandidates(cone.polygon);
                if (all.length + hazards.length > 5000 || !aheadGeometryWithinLimit(hazards))
                    return { coverage: 'partial', danger };
                loaded++;
                all.push(...hazards);
                danger ||=
                    scanAhead(cone, hazards, q.draftM, q.ukcM, (t) => (held.datum === 'LAT' ? tideAt(q, t) : null)) !==
                    null;
            }
            return {
                coverage:
                    loaded === 0
                        ? 'unavailable'
                        : loaded === relevant.length && relevant.length <= 8 && coneIsCovered(cone, all)
                          ? 'charted'
                          : 'partial',
                danger,
            };
        } catch {
            return { coverage: 'partial', danger };
        } finally {
            this.busy = false;
        }
    }
}
