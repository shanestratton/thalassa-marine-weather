
import { RadioTowerIcon } from '../Icons';
import { Countdown } from './Countdown';

interface StatusBadgesProps {
    isLandlocked: boolean;
    locationName: string;
    displaySource: string;
    nextUpdate: number | null;
    fallbackInland?: boolean;
    stationId?: string;
    locationType?: 'coastal' | 'offshore' | 'inland';
    beaconName?: string;
    buoyName?: string;
}

export const StatusBadges: React.FC<StatusBadgesProps> = ({
    isLandlocked,
    locationName,
    displaySource,
    nextUpdate,
    fallbackInland,
    stationId,
    locationType,
    beaconName,
    buoyName
}) => {
    const shortenSourceName = (name: string): string => {
        // Abbreviate common words

        // Abbreviate common words
        name = name.replace(/Brisbane/i, 'Bris');
        name = name.replace(/Moreton Bay/i, 'MB');
        name = name.replace(/Central/i, 'Ctr');
        name = name.replace(/Inner/i, 'In');
        name = name.replace(/Outer/i, 'Out');
        name = name.replace(/Beacon/i, 'Bcn');
        name = name.replace(/Point/i, 'Pt');
        name = name.replace(/ Bay/i, 'B');
        name = name.replace(/North/i, 'N');
        name = name.replace(/South/i, 'S');
        name = name.replace(/East/i, 'E');
        name = name.replace(/West/i, 'W');

        // Replace full 'BUOY' with abbreviation
        name = name.replace(/BUOY/i, 'BY');

        // If still too long (>12 chars), truncate more aggressively
        if (name.length > 12) {
            name = name.substring(0, 10) + '..';
        }

        return name;
    };

    // BADGES Logic
    let statusBadgeLabel = "OFFSHORE";
    let statusBadgeColor = "bg-sky-500/20 text-sky-300 border-sky-500/30";

    // Priority: Explicit Location Type
    if (locationType === 'offshore') {
        statusBadgeLabel = "OFFSHORE";
        statusBadgeColor = "bg-sky-500/20 text-sky-300 border-sky-500/30";
    } else if (locationType === 'inland' || isLandlocked || fallbackInland) {
        statusBadgeLabel = "INLAND";
        statusBadgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/30";
    } else {
        // Default / Coastal
        statusBadgeLabel = "COASTAL";
        statusBadgeColor = "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
    }

    let timerBadgeColor = "bg-blue-500/20 text-blue-300 border-blue-500/30";

    const hasStormGlass = true; // Always present as fallback

    return (
        <div className="px-0 -mt-4 shrink-0 relative z-20">
            <div className="flex items-center justify-between gap-1 md:gap-2 w-full mb-0">
                {/* Coastal / Offshore Badge */}
                <div className={`px-2 py-1.5 rounded-lg border text-[9px] font-bold uppercase tracking-wider ${statusBadgeColor} bg-black/40`}>
                    {statusBadgeLabel}
                </div>

                {/* Multi-Source Badge */}
                <div className="px-2 py-1.5 rounded-lg border text-[9px] font-bold uppercase tracking-wider bg-black/40 border-white/20 flex-1 min-w-0 flex items-center justify-center gap-1.5 overflow-hidden">
                    <RadioTowerIcon className="w-2.5 h-2.5 shrink-0 text-white/70" />
                    <div className="flex items-center gap-1.5 truncate">
                        {beaconName && (
                            <>
                                <span className="text-emerald-400 font-bold">{shortenSourceName(beaconName)}</span>
                                {(buoyName || hasStormGlass) && <span className="text-white/30">•</span>}
                            </>
                        )}
                        {buoyName && (
                            <>
                                <span className="text-emerald-400 font-bold">{shortenSourceName(buoyName)}</span>
                                {hasStormGlass && <span className="text-white/30">•</span>}
                            </>
                        )}
                        {hasStormGlass && (
                            <span className="text-amber-400 font-bold">SG</span>
                        )}
                    </div>
                </div>

                {/* Timer Badge */}
                <div className={`px-1.5 py-1.5 rounded-lg border text-[8px] font-bold uppercase tracking-wider ${timerBadgeColor} bg-black/40 flex items-center gap-1 min-w-[60px] justify-center`}>
                    {nextUpdate ? <Countdown targetTime={nextUpdate} /> : "LIVE"}
                </div>
            </div>
        </div>
    );
};
