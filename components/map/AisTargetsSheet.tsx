/** Loaded only when the skipper opens Targets. Both sensors keep their full picture. */
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { RadarStore } from '../../services/radar/radarStore';
import { radarDisplayRows } from '../../services/radar/radarPresentation';
import { AisStore } from '../../services/AisStore';
import { gradeCollisionTargets, readCollisionInputs } from '../../services/AisGuardWatch';
import { readAisTargetPicture, subscribeAisTargetPicture } from '../../services/ais/aisTargetCache';
import { aisDisplayPasses } from '../../services/ais/aisFilter';
import { aisReportAgeSec } from '../../services/ais/aisDeadReckon';
import { useSettingsStore } from '../../stores/settingsStore';
import { calculateBearing, calculateDistance } from '../../utils/navigationCalculations';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { AisCoverageNotice } from './AisCoverageNotice';
const BuddyWatchSheet = lazy(() => import('./BuddyWatchSheet'));

export function AisTargetsSheet({
    onClose,
    onSelect,
}: {
    onClose: () => void;
    onSelect: (feature: GeoJSON.Feature<GeoJSON.Point>) => void;
}) {
    const [now, setNow] = useState(Date.now);
    const [buddy, setBuddy] = useState<{ mmsi: number; label: string } | null | undefined>(undefined);
    const filters = useSettingsStore((state) => state.settings.aisDisplayFilters);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, { onEscape: onClose });
    useEffect(() => {
        const refresh = () => setNow(Date.now());
        const local = AisStore.subscribe(refresh);
        const internet = subscribeAisTargetPicture(refresh);
        const timer = window.setInterval(refresh, 5000);
        return () => {
            local();
            internet();
            window.clearInterval(timer);
        };
    }, []);
    const radarPicture = useSyncExternalStore(RadarStore.subscribe, RadarStore.getSnapshot);
    const features = readAisTargetPicture();
    const inputs = readCollisionInputs(now);
    const graded = inputs.own
        ? gradeCollisionTargets(
              inputs.own,
              inputs.motion,
              features,
              inputs.prefs,
              inputs.ownMmsis,
              now,
              inputs.atAnchor,
          )
        : [];
    const assessments = new Map(graded.map((candidate) => [candidate.mmsi, candidate.assessment]));
    const radarRows = radarDisplayRows(
        radarPicture,
        features.filter((f) => !inputs.ownMmsis.has(Number(f.properties?.mmsi))),
        now,
        inputs.prefs,
        inputs.atAnchor,
        assessments,
    ).sort((a, b) => (a.rangeNm ?? Infinity) - (b.rangeNm ?? Infinity));
    const radarMerged = new Set(radarRows.flatMap((r) => (r.ais ? [Number(r.ais.properties?.mmsi)] : [])));
    const rows = features
        .flatMap((feature) => {
            const p = feature.properties ?? {};
            const mmsi = Number(p.mmsi);
            if (
                radarMerged.has(mmsi) ||
                inputs.ownMmsis.has(mmsi) ||
                !aisDisplayPasses(p, filters, assessments.get(mmsi)?.risk)
            )
                return [];
            const [lon, lat] = feature.geometry.coordinates;
            const distance = inputs.own ? calculateDistance(inputs.own.lat, inputs.own.lon, lat, lon) : null;
            const bearing = inputs.own ? calculateBearing(inputs.own.lat, inputs.own.lon, lat, lon) : null;
            return [
                {
                    feature,
                    p,
                    mmsi,
                    distance,
                    bearing,
                    assessment: assessments.get(mmsi),
                    age: aisReportAgeSec(p, now),
                },
            ];
        })
        .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    return (
        <OverlayPortal
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="AIS targets"
            className="flex flex-col bg-slate-950/95 p-4 text-white"
            style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}
        >
            <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-bold">Targets · {rows.length + radarRows.length}</h2>
                <button type="button" className="min-h-[44px] px-4" onClick={onClose} aria-label="Close targets">
                    Close
                </button>
            </div>
            <p className="mb-3 text-xs text-slate-400">
                Display filters from Preferences apply. DANGER, CAUTION and distress always show. Tap a vessel for its
                details. Radar requires a connected physical feed; ambiguous motion stays range only.
            </p>
            <button type="button" className="min-h-11 self-start px-3" onClick={() => setBuddy(null)}>
                Buddy boats
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto space-y-2">
                <AisCoverageNotice />
                {rows.length === 0 && radarRows.length === 0 && (
                    <p className="p-4 text-sm text-slate-300">No targets match the display filters.</p>
                )}
                {radarRows.map((row) => (
                    <div key={row.contact.contactKey}>
                        <button
                            type="button"
                            className="min-h-[64px] w-full rounded-xl border border-cyan-400/30 bg-slate-900 p-3 text-left"
                            onClick={() =>
                                onSelect({
                                    type: 'Feature',
                                    geometry: {
                                        type: 'Point',
                                        coordinates: [row.contact.position!.lon, row.contact.position!.lat],
                                    },
                                    properties: { source: 'radar', radarContactKey: row.contact.contactKey },
                                })
                            }
                        >
                            <span className="block font-bold">
                                {row.ais ? 'AIS + radar' : 'Radar'} · {row.name}
                                {row.assessment?.risk === 'DANGER' || row.assessment?.risk === 'CAUTION'
                                    ? ` · ${row.assessment.risk}`
                                    : ''}
                            </span>
                            <span className="block text-xs text-slate-300">
                                {row.rangeNm === null ? 'Range —' : `${row.rangeNm.toFixed(2)} NM`} ·
                                {row.bearingDeg === null
                                    ? ' Bearing —'
                                    : ` ${Math.round(row.bearingDeg).toString().padStart(3, '0')}°T`}{' '}
                                · CPA{' '}
                                {row.assessment?.cpaNm == null ? 'unknown' : `${row.assessment.cpaNm.toFixed(2)} NM`}
                            </span>
                            <span className="block text-xs text-slate-400">
                                Radar target {row.contact.targetNumber} · {row.contact.talker} ·{' '}
                                {Math.max(0, Math.round((now - row.contact.at) / 1000))} s old
                                {row.contact.fresh ? '' : ' · stale'}
                                {!row.contact.motion ? ' · ground motion unknown' : ''}
                                {row.ais ? ` · MMSI ${Number(row.ais.properties?.mmsi)}` : ''}
                            </span>
                        </button>
                        {row.ais &&
                            Number(row.ais.properties?.mmsi) >= 100_000_000 &&
                            Number(row.ais.properties?.mmsi) <= 799_999_999 && (
                                <button
                                    type="button"
                                    aria-label={`Follow AIS MMSI ${Number(row.ais.properties?.mmsi)}`}
                                    className="min-h-11 px-3"
                                    onClick={() =>
                                        setBuddy({ mmsi: Number(row.ais!.properties?.mmsi), label: row.name })
                                    }
                                >
                                    Follow
                                </button>
                            )}
                    </div>
                ))}
                {rows.map(({ feature, p, mmsi, distance, bearing, assessment, age }) => (
                    <div key={mmsi}>
                        <button
                            type="button"
                            onClick={() => onSelect(feature)}
                            className="min-h-[64px] w-full rounded-xl border border-white/10 bg-slate-900 p-3 text-left"
                        >
                            <span className="block font-bold">
                                {String(p.name || `MMSI ${mmsi}`)}{' '}
                                {assessment?.risk === 'DANGER' || assessment?.risk === 'CAUTION'
                                    ? `· ${assessment.risk}`
                                    : ''}
                            </span>
                            <span className="block text-xs text-slate-300">
                                {distance === null ? 'Range —' : `${distance.toFixed(2)} NM`} ·{' '}
                                {bearing === null
                                    ? 'Bearing —'
                                    : `${Math.round(bearing).toString().padStart(3, '0')}°T`}{' '}
                                · CPA {assessment?.cpaNm == null ? '—' : `${assessment.cpaNm.toFixed(2)} NM`}
                            </span>
                            <span className="block text-xs text-slate-400">
                                MMSI {mmsi} ·{' '}
                                {p.source === 'local' ? 'Boat receiver' : 'Internet · informational, silent'}
                                {p.aisClass ? ` · Class ${String(p.aisClass)}` : ''} ·{' '}
                                {age === null
                                    ? 'Age unknown'
                                    : age < 60
                                      ? `${Math.round(age)} s old`
                                      : `${Math.floor(age / 60)} min old`}
                            </span>
                        </button>
                        {mmsi >= 100_000_000 && mmsi <= 799_999_999 && (
                            <button
                                type="button"
                                aria-label={`Follow AIS MMSI ${mmsi}`}
                                className="min-h-11 px-3"
                                onClick={() => setBuddy({ mmsi, label: String(p.name || `MMSI ${mmsi}`) })}
                            >
                                Follow
                            </button>
                        )}
                    </div>
                ))}
            </div>
            {buddy !== undefined && (
                <Suspense fallback={<p role="status">Opening buddy boats…</p>}>
                    <BuddyWatchSheet candidate={buddy ?? undefined} onClose={() => setBuddy(undefined)} />
                </Suspense>
            )}
        </OverlayPortal>
    );
}
