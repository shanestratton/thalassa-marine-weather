/** Loaded only when the skipper opens Targets. Both sensors keep their full picture. */
import { useEffect, useState } from 'react';
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

export function AisTargetsSheet({
    onClose,
    onSelect,
}: {
    onClose: () => void;
    onSelect: (feature: GeoJSON.Feature<GeoJSON.Point>) => void;
}) {
    const [now, setNow] = useState(Date.now);
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
    const rows = features
        .flatMap((feature) => {
            const p = feature.properties ?? {};
            const mmsi = Number(p.mmsi);
            if (inputs.ownMmsis.has(mmsi) || !aisDisplayPasses(p, filters, assessments.get(mmsi)?.risk)) return [];
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
                <h2 className="text-lg font-bold">Targets · {rows.length}</h2>
                <button type="button" className="min-h-[44px] px-4" onClick={onClose} aria-label="Close targets">
                    Close
                </button>
            </div>
            <p className="mb-3 text-xs text-slate-400">
                Display filters from Preferences apply. DANGER, CAUTION and distress always show. Tap a vessel for its
                details.
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto space-y-2">
                <AisCoverageNotice />
                {rows.length === 0 && (
                    <p className="p-4 text-sm text-slate-300">No targets match the display filters.</p>
                )}
                {rows.map(({ feature, p, mmsi, distance, bearing, assessment, age }) => (
                    <button
                        type="button"
                        key={mmsi}
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
                            {bearing === null ? 'Bearing —' : `${Math.round(bearing).toString().padStart(3, '0')}°T`} ·
                            CPA {assessment?.cpaNm == null ? '—' : `${assessment.cpaNm.toFixed(2)} NM`}
                        </span>
                        <span className="block text-xs text-slate-400">
                            MMSI {mmsi} · {p.source === 'local' ? 'Boat receiver' : 'Internet · informational, silent'}
                            {p.aisClass ? ` · Class ${String(p.aisClass)}` : ''} ·{' '}
                            {age === null
                                ? 'Age unknown'
                                : age < 60
                                  ? `${Math.round(age)} s old`
                                  : `${Math.floor(age / 60)} min old`}
                        </span>
                    </button>
                ))}
            </div>
        </OverlayPortal>
    );
}
