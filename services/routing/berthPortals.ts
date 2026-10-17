/** Candidate relief never proves clearance. Only complete current chart cohorts
 * and the existing clear lead classification can qualify a shared portal. */
import { haversineNm } from '../isochrone/geodesy';
import type { LeadGraph, LeadCellInput } from './leadCompiler';
import type { BerthPoint, BerthPortal, BerthPortalLease } from './berthToBerth';
import { MAX_MERGE_CELLS, MAX_MERGE_REGISTER_BYTES } from '../enc/mergeCap';
import { withDeadline } from '../../utils/deadline';

const distance = (a: BerthPoint, b: BerthPoint) => haversineNm(a.lat, a.lon, b.lat, b.lon);
const normalLon = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
export function berthSearchPoints(from: BerthPoint): BerthPoint[] {
    const points: BerthPoint[] = [],
        r = Math.PI / 180;
    for (const nm of [5, 15, 30, 43])
        for (let angle = 0; angle < 360; angle += 30) {
            const d = nm / 3440.065,
                a = from.lat * r,
                b = angle * r;
            const lat = Math.asin(Math.sin(a) * Math.cos(d) + Math.cos(a) * Math.sin(d) * Math.cos(b));
            const lon =
                from.lon * r +
                Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(a), Math.cos(d) - Math.sin(a) * Math.sin(lat));
            if (Math.abs(lat / r) <= 83) points.push({ lat: lat / r, lon: normalLon(lon / r) });
        }
    return points;
}
type Bounds = [number, number, number, number];
export function berthPortalViews(point: BerthPoint): Bounds[] {
    const dy = 2 / 60,
        dx = dy / Math.cos((point.lat * Math.PI) / 180),
        west = point.lon - dx,
        east = point.lon + dx;
    if (west < -180)
        return [
            [-180, point.lat - dy, east, point.lat + dy],
            [west + 360, point.lat - dy, 180, point.lat + dy],
        ];
    if (east > 180)
        return [
            [west, point.lat - dy, 180, point.lat + dy],
            [-180, point.lat - dy, east - 360, point.lat + dy],
        ];
    return [[west, point.lat - dy, east, point.lat + dy]];
}
/** Pure admission. OSM, unknown survey/structures, tide-dependent and shallow
 * leads never qualify a handover, even when the coarse relief reads deep. */
export function chartedBerthPortals(
    graph: Pick<LeadGraph, 'edges'>,
    berth: BerthPoint,
    reliefPoint: BerthPoint,
    sourceKey: string,
    draftM: number,
): BerthPortal[] {
    if (graph.edges.length > 10000 || !sourceKey) return [];
    const out: BerthPortal[] = [];
    for (const edge of graph.edges) {
        const depth = edge.depth.minDepthM;
        if (
            edge.trust !== 'chart' ||
            edge.depth.class !== 'clear' ||
            edge.depth.review.length ||
            edge.depth.uncoveredM > 1 ||
            edge.sourceLandM > 0 ||
            edge.directionUnresolved ||
            depth === null ||
            !Number.isFinite(depth) ||
            depth < Math.max(10, draftM + 0.5)
        )
            continue;
        for (const p of [edge.coordinates[0], edge.coordinates.at(-1)]) {
            if (!p || !p.every(Number.isFinite)) continue;
            const at = { lon: p[0], lat: p[1] },
                range = distance(berth, at);
            if (
                range < 0.1 ||
                range > 45 ||
                distance(reliefPoint, at) > 2 ||
                out.some((o) => distance(o.at, at) < 0.01)
            )
                continue;
            out.push({ id: edge.id + ':' + out.length, at, depthM: depth, sourceKey });
        }
    }
    return out.sort((a, b) => distance(berth, a.at) - distance(berth, b.at) || a.id.localeCompare(b.id)).slice(0, 4);
}
export async function prepareBerthPortalLeases(input: {
    origin: BerthPoint;
    destination: BerthPoint;
    draftM: number;
    airDraftM: number | null;
    draftAssumed: boolean;
    signal: AbortSignal;
    current: () => boolean;
    remaining: () => number;
}): Promise<[BerthPortalLease, BerthPortalLease]> {
    const [
        { GebcoDepthService },
        { ensureBoatCells, boatLanBaseNow },
        { cellsForBBox, getVersion, getRegistryFingerprint },
        { getPairing },
        { getAuthIdentityScope, isAuthIdentityScopeCurrent },
        { noaaAgreementAccepted },
        { isProtectedChart },
        { loadNoaaPackageCohort },
        { loadCellGeoJSON },
        { compileLeadGraph, mergeLeadCells },
        { utf8ByteLength },
    ] = await Promise.all([
        import('../GebcoDepthService'),
        import('../enc/piCellSync'),
        import('../enc/EncCellMetadata'),
        import('../PiPairingService'),
        import('../authIdentityScope'),
        import('../enc/noaaAgreement'),
        import('../enc/chartLicence'),
        import('../enc/noaaPackageWindow'),
        import('../enc/EncCellStore'),
        import('./leadCompiler'),
        import('../enc/types'),
    ]);
    const scope = getAuthIdentityScope();
    const check = () => {
        if (input.signal.aborted || !input.current() || !isAuthIdentityScopeCurrent(scope))
            throw Error('Chart portal preparation expired or its owner changed.');
    };
    check();
    const candidates: BerthPoint[][] = [];
    // At most two public 48-point relief requests; no guessed fallback.
    for (const berth of [input.origin, input.destination]) {
        check();
        const points = berthSearchPoints(berth);
        const depths = await withDeadline(
            GebcoDepthService.queryDepths(points),
            input.remaining(),
            'berth relief candidates',
        );
        check();
        if (depths.length !== points.length)
            throw Error('Complete relief candidates are unavailable for the berth approach.');
        candidates.push(
            points
                .filter(
                    (p, i) =>
                        typeof depths[i]?.depth_m === 'number' &&
                        depths[i].depth_m! <= -50 &&
                        distance(p, depths[i]) < 0.1,
                )
                .slice(0, 4),
        );
    }
    if (candidates.some((c) => !c.length))
        throw Error('No observed deep-water candidate is available; no guessed gate was used.');
    const windows = candidates.map((group) => group.flatMap(berthPortalViews));
    // Finish any authorised boat-LAN registry/cell opens BEFORE capturing both
    // endpoint cohorts. Later window reads cannot restamp an earlier fact.
    for (const bounds of windows.flat()) {
        check();
        await withDeadline(
            ensureBoatCells(bounds, { maxCells: MAX_MERGE_CELLS }),
            input.remaining(),
            'boat approach charts',
        );
        check();
    }
    const version = getVersion(),
        consent = await noaaAgreementAccepted(scope);
    check();
    const cohortCurrent = () =>
        input.current() && !input.signal.aborted && isAuthIdentityScopeCurrent(scope) && getVersion() === version;
    const cohortCheck = () => {
        if (!cohortCurrent()) throw Error('An endpoint chart cohort changed during berth routing.');
    };
    const leases: BerthPortalLease[] = [];
    try {
        for (let end = 0; end < 2; end++) {
            const facts: BerthPortal[] = [];
            let released = false;
            const authorities: Array<() => void> = [];
            for (let i = 0; i < candidates[end].length; i++)
                for (const bounds of berthPortalViews(candidates[end][i])) {
                    cohortCheck();
                    const cells = cellsForBBox(bounds);
                    if (!cells.length) continue;
                    if (
                        cells.length > MAX_MERGE_CELLS ||
                        cells.reduce((n, c) => n + (c.sizeBytes ?? 0), 0) > MAX_MERGE_REGISTER_BYTES
                    )
                        throw Error('The complete endpoint chart cohort exceeds the existing cell/byte bound.');
                    if (cells.some((c) => (isProtectedChart(c) ? !getPairing() || !boatLanBaseNow() : !consent)))
                        throw Error('An endpoint chart needs current NOAA consent or the paired boat LAN.');
                    const sourceKey = getRegistryFingerprint(bounds);
                    const packages = await loadNoaaPackageCohort(
                        cells.filter((c) => c.noaaPackage),
                        bounds,
                        cohortCheck,
                    );
                    const inputs: LeadCellInput[] = [];
                    let bytes = 0,
                        features = 0;
                    try {
                        for (const cell of cells) {
                            const blob = cell.noaaPackage
                                ? packages.blobs.get(cell.id)
                                : await loadCellGeoJSON(cell.id, false);
                            cohortCheck();
                            packages.check();
                            if (!blob?.layers || (blob.extractorSchema ?? 0) < 2)
                                throw Error(
                                    'An endpoint chart cohort is incomplete or lacks current structure extraction.',
                                );
                            bytes += utf8ByteLength(JSON.stringify(blob), MAX_MERGE_REGISTER_BYTES - bytes);
                            features += Object.values(blob.layers).reduce(
                                (n, fc) => n + (fc?.features?.length ?? 0),
                                0,
                            );
                            if (bytes > MAX_MERGE_REGISTER_BYTES || features > 10000)
                                throw Error('The complete endpoint chart read exceeds its bounded detail budget.');
                            inputs.push({
                                id: cell.id,
                                bbox: cell.bbox,
                                layers: blob.layers as LeadCellInput['layers'],
                                nativeScale: blob.nativeScale,
                                sourceCellId: cell.sourceCellId ?? blob.sourceCellId,
                            });
                        }
                        const graph = compileLeadGraph(mergeLeadCells(inputs), input.draftM, { window: bounds }, 0.5, {
                            draftAssumed: input.draftAssumed,
                            airDraftM: input.airDraftM,
                        });
                        cohortCheck();
                        packages.check();
                        for (const fact of chartedBerthPortals(
                            graph,
                            end ? input.destination : input.origin,
                            candidates[end][i],
                            sourceKey,
                            input.draftM,
                        ))
                            if (!facts.some((f) => distance(f.at, fact.at) < 0.01) && facts.length < 4)
                                facts.push(fact);
                        const protectedIds = cells.filter(isProtectedChart).map((c) => c.id);
                        const authority = packages.authority;
                        authorities.push(() => {
                            cohortCheck();
                            authority();
                            if (
                                getRegistryFingerprint(bounds) !== sourceKey ||
                                (protectedIds.length && (!getPairing() || !boatLanBaseNow()))
                            )
                                throw Error('An endpoint chart lease is no longer available.');
                        });
                    } finally {
                        inputs.length = 0;
                        packages.release();
                    }
                }
            const lease: BerthPortalLease = {
                candidates: facts,
                current: () => {
                    if (released) return false;
                    try {
                        cohortCheck();
                        authorities.forEach((fn) => fn());
                        return true;
                    } catch {
                        return false;
                    }
                },
                release: () => {
                    released = true;
                    facts.length = 0;
                    authorities.length = 0;
                },
            };
            leases.push(lease);
        }
        return [leases[0], leases[1]];
    } catch (error) {
        leases.forEach((l) => l.release());
        throw error;
    }
}
