/** Planned-only provenance. This is deliberately NOT a TraceVerification or
 * permission to follow/export/cast off. No raw licensed provider payload here. */
import type { AutoroutingProviderCheck } from '../supabase/functions/_shared/autorouting-provider-check';
import {
    snapshotProviderFindingDetails,
    providerHazardVertexCount,
    PROVIDER_HAZARD_MAX_TOTAL_VERTICES,
} from '../supabase/functions/_shared/autorouting-provider-check';

import { traceRegistryScope } from './traceRegistryScope';

export const AUTOROUTING_PROPOSAL_MAX_POINTS = 10_000;
export const AUTOROUTING_PROPOSAL_EVIDENCE_MAX_BYTES = 1_048_576;
export interface AutoroutingReviewBasis {
    proposalId: string;
    geometryKey: string;
    draftM: number;
    draftAssumed: boolean;
    registryFingerprint: string;
    checkedAt: string;
    vesselProfileKey?: string;
}
export interface SavedAutoroutingProposalEvidence {
    version: 1;
    /** 'thalassa-inshore': Auto on the phone, the only origin written since
     * 2026-10-01. 'sevencs-trial': rows saved before then — read, never
     * written; only they may carry providerCheck or canalHandoverIndex. */
    origin: 'sevencs-trial' | 'thalassa-inshore';
    proposalId: string;
    providerCreatedAt: string;
    savedAt: string;
    plannedOnlyAcknowledged: true;
    basis: AutoroutingReviewBasis;
    warnings: string[];
    providerCheck?: AutoroutingProviderCheck;
    canalHandoverIndex?: number;
    legs: Array<{
        grade: 'clear' | 'caution';
        incomplete: boolean;
        minDepthM: number | null;
        minAt: { lat: number; lon: number } | null;
        issues: Array<{
            severity: 'caution';
            message: string;
            at?: { lat: number; lon: number };
            mark?: { lat: number; lon: number };
            chartTrack?: { id: string; label?: string; kind: 'leading-line' | 'recommended-track'; offsetM: number };
        }>;
    }>;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 4096): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;
const timestamp = (v: unknown): v is string => text(v, 64) && Number.isFinite(Date.parse(v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (v: unknown): boolean =>
    record(v) &&
    Object.keys(v).every((key) => key === 'lat' || key === 'lon') &&
    finite(v.lat) &&
    finite(v.lon) &&
    Math.abs(v.lat) <= 90 &&
    Math.abs(v.lon) <= 180;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));

/**
 * The charts round a proposal, as its review is bound to them (package
 * 125-06): the route check's and Cast Off's own scope (traceRegistryScope).
 * The review (useAutoroutingReview) and Save compare the same.
 */
export function autoroutingRegistryScope(
    coordinates: readonly (readonly [number, number])[],
): [number, number, number, number] | undefined {
    return traceRegistryScope(coordinates.map(([lon, lat]) => ({ lat, lon })));
}

/** Exact ordered coordinates, without metre-rounding or removing duplicates. */
export function autoroutingProposalGeometryKey(coordinates: readonly (readonly number[])[]): string {
    if (
        !Array.isArray(coordinates) ||
        coordinates.length < 2 ||
        coordinates.length > AUTOROUTING_PROPOSAL_MAX_POINTS ||
        ![...coordinates].every(
            (p) =>
                Array.isArray(p) &&
                p.length === 2 &&
                finite(p[0]) &&
                finite(p[1]) &&
                Math.abs(p[0]) <= 180 &&
                Math.abs(p[1]) <= 90,
        )
    )
        return '';
    return `autorouting-proposal-v1:${JSON.stringify(coordinates)}`;
}

/** Full geometry key is intentional: exact validation is synchronous on local
 * reads. The entire evidence object, including that key, is capped at 1 MiB;
 * oversized evidence refuses save rather than truncating warnings or points. */
export function normaliseAutoroutingProposalEvidence(
    value: unknown,
    points: readonly { lat: number; lon: number }[],
): SavedAutoroutingProposalEvidence | null {
    try {
        const encoded = JSON.stringify(value);
        if (
            !encoded ||
            encoded.length > AUTOROUTING_PROPOSAL_EVIDENCE_MAX_BYTES ||
            new TextEncoder().encode(encoded).byteLength > AUTOROUTING_PROPOSAL_EVIDENCE_MAX_BYTES
        )
            return null;
        const v: unknown = JSON.parse(encoded);
        if (
            !record(v) ||
            !keys(v, [
                'version',
                'origin',
                'proposalId',
                'providerCreatedAt',
                'savedAt',
                'plannedOnlyAcknowledged',
                'basis',
                'warnings',
                'providerCheck',
                'canalHandoverIndex',
                'legs',
            ]) ||
            v.version !== 1 ||
            (v.origin !== 'sevencs-trial' && v.origin !== 'thalassa-inshore') ||
            (v.origin === 'thalassa-inshore' &&
                (v.providerCheck !== undefined || v.canalHandoverIndex !== undefined)) ||
            !text(v.proposalId, 200) ||
            !timestamp(v.providerCreatedAt) ||
            !timestamp(v.savedAt) ||
            v.plannedOnlyAcknowledged !== true ||
            !record(v.basis) ||
            !keys(v.basis, [
                'proposalId',
                'geometryKey',
                'draftM',
                'draftAssumed',
                'registryFingerprint',
                'checkedAt',
                'vesselProfileKey',
            ]) ||
            v.basis.proposalId !== v.proposalId ||
            !finite(v.basis.draftM) ||
            v.basis.draftM <= 0 ||
            v.basis.draftM > 30 ||
            typeof v.basis.draftAssumed !== 'boolean' ||
            typeof v.basis.registryFingerprint !== 'string' ||
            v.basis.registryFingerprint.length > 500_000 ||
            !timestamp(v.basis.checkedAt) ||
            (v.basis.vesselProfileKey !== undefined && !text(v.basis.vesselProfileKey, 8192)) ||
            !Array.isArray(points) ||
            ![...points].every(point) ||
            !v.basis.geometryKey ||
            v.basis.geometryKey !== autoroutingProposalGeometryKey(points.map((p) => [p.lon, p.lat])) ||
            !Array.isArray(v.warnings) ||
            v.warnings.length > 500 ||
            ![...v.warnings].every((w) => text(w)) ||
            !Array.isArray(v.legs) ||
            v.legs.length !== points.length - 1 ||
            (v.canalHandoverIndex !== undefined &&
                (!Number.isInteger(v.canalHandoverIndex) ||
                    (v.canalHandoverIndex as number) < 0 ||
                    (v.canalHandoverIndex as number) >= points.length - 1))
        )
            return null;
        if (v.providerCheck !== undefined) {
            const report = v.providerCheck;
            if (
                !record(report) ||
                !keys(report, ['status', 'findings']) ||
                !['caution', 'not-reported'].includes(report.status as string) ||
                !Array.isArray(report.findings) ||
                report.findings.length > 100 ||
                ![...report.findings].every(
                    (f) =>
                        record(f) &&
                        keys(f, [
                            'featureIndex',
                            'featureType',
                            'providerSeverity',
                            'severity',
                            'message',
                            'geometry',
                            'provenance',
                        ]) &&
                        Number.isInteger(f.featureIndex) &&
                        (f.featureIndex as number) >= 0 &&
                        (f.featureIndex as number) < AUTOROUTING_PROPOSAL_MAX_POINTS &&
                        f.severity === 'caution' &&
                        text(f.message) &&
                        (f.featureType === undefined || text(f.featureType, 2000)) &&
                        (f.providerSeverity === undefined || text(f.providerSeverity, 2000)) &&
                        snapshotProviderFindingDetails(f) !== null,
                ) ||
                (report.status === 'not-reported') !== (report.findings.length === 0)
            )
                return null;
            const vertices = report.findings.reduce((total, finding) => {
                const details = snapshotProviderFindingDetails(finding)!;
                return total + (details.geometry ? providerHazardVertexCount(details.geometry) : 0);
            }, 0);
            if (vertices > PROVIDER_HAZARD_MAX_TOTAL_VERTICES) return null;
            for (const finding of report.findings) {
                if (
                    (finding.geometry !== undefined && !keys(finding.geometry, ['type', 'coordinates'])) ||
                    (finding.provenance !== undefined &&
                        !keys(finding.provenance, ['source', 'properties', 'omittedPropertyCount']))
                )
                    return null;
            }
        }
        for (const leg of v.legs) {
            if (
                !record(leg) ||
                !keys(leg, ['grade', 'incomplete', 'minDepthM', 'minAt', 'issues']) ||
                !['clear', 'caution'].includes(leg.grade as string) ||
                typeof leg.incomplete !== 'boolean' ||
                (leg.minDepthM !== null && !finite(leg.minDepthM)) ||
                (leg.minAt !== null && !point(leg.minAt)) ||
                !Array.isArray(leg.issues) ||
                leg.issues.length > 1000
            )
                return null;
            for (const issue of leg.issues) {
                if (
                    !record(issue) ||
                    !keys(issue, ['severity', 'message', 'at', 'mark', 'chartTrack']) ||
                    issue.severity !== 'caution' ||
                    !text(issue.message) ||
                    (issue.at !== undefined && !point(issue.at)) ||
                    (issue.mark !== undefined && !point(issue.mark))
                )
                    return null;
                if (issue.chartTrack !== undefined) {
                    const track = issue.chartTrack;
                    if (
                        !record(track) ||
                        !keys(track, ['id', 'label', 'kind', 'offsetM']) ||
                        !text(track.id, 2000) ||
                        (track.label !== undefined && (typeof track.label !== 'string' || track.label.length > 2000)) ||
                        !['leading-line', 'recommended-track'].includes(track.kind as string) ||
                        !finite(track.offsetM) ||
                        track.offsetM < 0
                    )
                        return null;
                }
            }
        }
        return v as unknown as SavedAutoroutingProposalEvidence;
    } catch {
        return null;
    }
}
