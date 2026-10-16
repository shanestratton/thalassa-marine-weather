import { useSyncExternalStore } from 'react';
import { getVersion, subscribe } from '../../services/enc/EncCellMetadata';
import { currentHoldingGroundAt } from '../../services/enc/holdingGround';

export function useHoldingGroundAdvice(lat: number, lon: number) {
    // Re-read when the active chart library changes; the read remains bounded
    // and synchronous, including while a newly selected cell is still unloaded.
    useSyncExternalStore(subscribe, getVersion, getVersion);
    return currentHoldingGroundAt(lat, lon);
}

/** Informational only; no write, alarm, anchor veto or scoring effect. */
export function HoldingGroundText({
    advice,
    className = '',
    atGps = false,
}: {
    advice: ReturnType<typeof currentHoldingGroundAt>;
    className?: string;
    atGps?: boolean;
}) {
    if (advice.kind === 'unknown') return null;
    return (
        <p data-testid="holding-ground-advice" className={`text-xs leading-snug text-slate-400 ${className}`}>
            {atGps ? 'At the current GPS position: ' : ''}
            {advice.text}
        </p>
    );
}

export function HoldingGroundNote({
    lat,
    lon,
    ...props
}: {
    lat: number;
    lon: number;
    className?: string;
    atGps?: boolean;
}) {
    const advice = useHoldingGroundAdvice(lat, lon);
    return <HoldingGroundText advice={advice} {...props} />;
}
