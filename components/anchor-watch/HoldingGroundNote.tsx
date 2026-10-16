import { useSyncExternalStore } from 'react';
import { getVersion, subscribe } from '../../services/enc/EncCellMetadata';
import { currentHoldingGroundAt } from '../../services/enc/holdingGround';

/** Informational only; no write, alarm, anchor veto or scoring effect. */
export function HoldingGroundNote({
    lat,
    lon,
    className = '',
    atGps = false,
}: {
    lat: number;
    lon: number;
    className?: string;
    atGps?: boolean;
}) {
    // Re-read when the active chart library changes; the read remains bounded
    // and synchronous, including while a newly selected cell is still unloaded.
    useSyncExternalStore(subscribe, getVersion, getVersion);
    const advice = currentHoldingGroundAt(lat, lon);
    if (advice.kind === 'unknown') return null;
    return (
        <p data-testid="holding-ground-advice" className={`text-xs leading-snug text-slate-400 ${className}`}>
            {atGps ? 'At the current GPS position: ' : ''}
            {advice.text}
        </p>
    );
}
