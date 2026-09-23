/** Recheck a reviewed exit against this device's installed navigation charts.
 * Standard licensed-chart read-through is allowed only after navigation
 * registration is confirmed; never promote an uninstalled/reference chart. */
import {
    VERIFIED_CANAL_EXIT_PROFILES,
    isVerifiedCanalExitProfileCurrent,
    type VerifiedCanalExitProfile,
    type VerifiedLateralMarker,
} from './automaticCanalExit';
import { getCell } from './enc/EncCellMetadata';
import { loadCellGeoJSON } from './enc/EncCellStore';
import type { EncCell, EncConversionResult } from './enc/types';

type Evidence = NonNullable<VerifiedCanalExitProfile['chartEvidence']>[number];
type MarkerReference = { cellId: string; layer: 'BOYLAT' | 'BCNLAT'; rcid: number; marker: VerifiedLateralMarker };
const MAX_CELL_MARKS = 20_000;
const MAX_VERIFICATION_MS = 15_000;

function markerReference(marker: VerifiedLateralMarker): MarkerReference | null {
    const match = /^([A-Z0-9][A-Z0-9_-]{1,63})\/(BOYLAT|BCNLAT)\/(0|[1-9]\d{0,9})$/.exec(marker.id);
    if (!match || match[2] !== marker.objectClass || Number(match[3]) > 4_294_967_295) return null;
    return { cellId: match[1], layer: marker.objectClass, rcid: Number(match[3]), marker };
}

function metadataRevision(evidence: Evidence): string | null {
    const cell: EncCell | null = getCell(evidence.cellId);
    if (
        !cell ||
        cell.id !== evidence.cellId ||
        cell.edition !== evidence.edition ||
        cell.issued !== evidence.issued ||
        (cell.usage !== undefined && cell.usage !== 'navigation') ||
        (cell.cloudManifestVersion !== undefined && cell.hazardCount === 0)
    )
        return null;
    return JSON.stringify([
        cell.id,
        cell.edition,
        cell.issued,
        cell.usage,
        cell.importedAt,
        cell.geojsonPath,
        cell.sizeBytes,
        cell.cloudManifestVersion,
        cell.personalManifestVersion,
    ]);
}

function cellMatches(blob: EncConversionResult | null, evidence: Evidence, markers: MarkerReference[]): boolean {
    if (
        !blob ||
        blob.cellId !== evidence.cellId ||
        blob.edition !== evidence.edition ||
        blob.issued !== evidence.issued ||
        !blob.layers
    )
        return false;
    for (const reference of markers) {
        const collection = blob.layers[reference.layer];
        if (
            !collection ||
            // Installed SENC extracts may omit the redundant collection type;
            // their actual layer wrapper is { features: [...] }.
            (collection.type !== undefined && collection.type !== 'FeatureCollection') ||
            !Array.isArray(collection.features) ||
            collection.features.length > MAX_CELL_MARKS
        )
            return false;
        let matched = false;
        for (const feature of collection.features) {
            const properties = feature?.properties;
            // Extractor identity is the numeric `rcid`, not OBJNAM, sequence,
            // colour or feature-array index. A malformed duplicate also fails.
            if (
                String(properties?.rcid) !== String(reference.rcid) &&
                String(properties?.RCID) !== String(reference.rcid)
            )
                continue;
            if (
                properties?.rcid !== reference.rcid ||
                (properties.RCID !== undefined && properties.RCID !== reference.rcid) ||
                properties.acronym !== reference.layer ||
                properties.CATLAM !== reference.marker.catlam ||
                feature.type !== 'Feature' ||
                feature.geometry?.type !== 'Point' ||
                feature.geometry.coordinates.length !== 2 ||
                feature.geometry.coordinates[0] !== reference.marker.lon ||
                feature.geometry.coordinates[1] !== reference.marker.lat
            )
                return false;
            // Identical repeated records add no evidence but do not conflict.
            // Any duplicate with a shifted position/category was rejected above.
            matched = true;
        }
        if (!matched) return false;
    }
    return true;
}

/** False includes unavailable, changed, expired, ambiguous and cancelled.
 * The caller must retain a manual exit path; no chart load failure is approval.
 * A non-cancellable local read may finish later, but cannot resolve true or
 * start a subsequent cell after this request was cancelled/timed out. */
export async function verifyCanalExitChart(profileId: string, signal: AbortSignal): Promise<boolean> {
    try {
        if (signal.aborted) return Promise.resolve(false);
        const profiles = VERIFIED_CANAL_EXIT_PROFILES.filter((profile) => profile.id === profileId);
        if (profiles.length !== 1 || !isVerifiedCanalExitProfileCurrent(profiles[0])) return Promise.resolve(false);
        const profile = profiles[0];
        const evidence = profile.chartEvidence;
        if (!evidence || evidence.length < 1 || evidence.length > 4) return Promise.resolve(false);
        const references = profile.gates.flatMap((gate) => [gate.port, gate.starboard]).map(markerReference);
        if (references.some((reference) => !reference)) return Promise.resolve(false);
        const marks = references as MarkerReference[];
        if (
            marks.some((reference) => !evidence.some((cell) => cell.cellId === reference.cellId)) ||
            evidence.some((cell) => !marks.some((reference) => reference.cellId === cell.cellId))
        )
            return Promise.resolve(false);
        const profileFingerprint = JSON.stringify(profile);
        return await new Promise((resolve) => {
            let finished = false;
            const finish = (verified: boolean) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                signal.removeEventListener('abort', cancelled);
                resolve(verified && !signal.aborted);
            };
            const cancelled = () => finish(false);
            const timer = setTimeout(() => finish(false), MAX_VERIFICATION_MS);
            signal.addEventListener('abort', cancelled, { once: true });
            const check = async () => {
                const revisions = new Map<string, string>();
                for (const cell of evidence) {
                    if (finished || signal.aborted) return false;
                    const revision = metadataRevision(cell);
                    if (revision === null) return false;
                    revisions.set(cell.cellId, revision);
                    const blob = await loadCellGeoJSON(cell.cellId);
                    if (
                        finished ||
                        signal.aborted ||
                        metadataRevision(cell) !== revision ||
                        !cellMatches(
                            blob,
                            cell,
                            marks.filter((mark) => mark.cellId === cell.cellId),
                        )
                    )
                        return false;
                }
                const current = VERIFIED_CANAL_EXIT_PROFILES.filter((candidate) => candidate.id === profileId);
                return (
                    !finished &&
                    !signal.aborted &&
                    current.length === 1 &&
                    isVerifiedCanalExitProfileCurrent(current[0]) &&
                    JSON.stringify(current[0]) === profileFingerprint &&
                    evidence.every((cell) => metadataRevision(cell) === revisions.get(cell.cellId))
                );
            };
            void check().then(finish, () => finish(false));
        });
    } catch {
        return false;
    }
}
