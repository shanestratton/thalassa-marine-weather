import { useEffect, useMemo, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import type { ScalarColourStop } from '../../services/weather/scalarGridImage';
import type { AtmosCredit } from './atmosPresentation';
import { useSshObservation, type SshMode } from './useSshObservation';
import { useScalarGridOverlay } from './useScalarGridOverlay';

const CREDIT =
    'Generated using E.U. Copernicus Marine Service Information; DOI 10.48670/moi-00149; copyright Mercator Ocean.';
const SLA: readonly ScalarColourStop[] = [
    [-1, 35, 65, 150, 150],
    [-0.3, 38, 175, 210, 140],
    [0, 220, 235, 240, 30],
    [0.3, 240, 175, 55, 140],
    [1, 195, 55, 45, 150],
];
const ADT: readonly ScalarColourStop[] = [
    [-2, 35, 65, 150, 150],
    [-0.5, 38, 175, 210, 140],
    [0, 220, 235, 240, 30],
    [0.5, 240, 175, 55, 140],
    [2, 195, 55, 45, 150],
];

/** Dated display-only ocean observations; this component adds no page furniture. */
export default function SshObservedLayer({
    mapRef,
    mapReady,
    active,
    mode,
    onCredit,
}: {
    mapRef: MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    active: boolean;
    mode: SshMode;
    onCredit: (credit: AtmosCredit | null) => void;
}) {
    const eligible = active && mode !== 'off';
    const observation = useSshObservation(eligible);
    const grid = mode === 'sla' ? observation.data?.sla : mode === 'adt' ? observation.data?.adt : null;
    const image = useScalarGridOverlay(mapRef, mapReady, {
        id: 'observed-ssh',
        label: 'Observed ocean map',
        credit: CREDIT,
        enabled: eligible,
        grid: grid ?? null,
        stops: mode === 'adt' ? ADT : SLA,
        revision: `${observation.data?.generation ?? 'none'}:${mode}`,
        sourceCurrent: observation.sourceCurrent,
    });
    const sourceTime = observation.data?.sourceTimeMs;
    const credit = useMemo<AtmosCredit | null>(() => {
        if (image === 'stuck-visible')
            return {
                key: 'observed-ssh',
                title: 'Ocean observations',
                warning: true,
                text: `A prior ocean observation layer may still be visible; removal or hiding could not be verified. Do not rely on that layer. ${CREDIT}`,
            };
        if (!eligible) return null;
        const ready = image === 'ready' && observation.phase === 'ready';
        const date =
            sourceTime === undefined
                ? 'Original map date unavailable'
                : `Mapped observation ${new Date(sourceTime).toISOString().slice(0, 10)} UTC`;
        const field = mode === 'sla' ? 'SLA relative to the 1993–2012 mean, metres' : 'ADT above the geoid, metres';
        const status = ready
            ? 'Ready'
            : observation.phase === 'loading' || image === 'loading'
              ? 'Loading'
              : 'Unavailable';
        return {
            key: 'observed-ssh',
            title: 'Ocean observations',
            warning: !ready,
            text: `${status}. ${date}. ${field}; 0.5° display grid. Geostrophic velocity is distinct from total and tidal current. This layer provides no tidal height, depth, clearance or routing input. ${CREDIT}`,
        };
    }, [eligible, image, mode, observation.phase, sourceTime]);
    useEffect(() => {
        onCredit(credit);
    }, [credit, onCredit]);
    useEffect(() => () => onCredit(null), [onCredit]);
    return null;
}
