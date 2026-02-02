
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
    airportName?: string;
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
    airportName
}) => {
    // Helper to shorten source names for compact badge display
    const shortenSourceName = (name: string): string => {
        // Remove common suffixes
        name = name.replace(/ Airport$/i, '').replace(/ Intl$/i, '').replace(/ International$/i, '');

        // Abbreviate "Brisbane" -> "Bris", "Moreton Bay" -> "MB", etc.
        name = name.replace(/Brisbane/i, 'Bris');
        name = name.replace(/Moreton Bay/i, 'MB');
        name = name.replace(/Central/i, 'Ctr');

        // If still too long (>15 chars), truncate
        if (name.length > 15) {
            name = name.substring(0, 15) + '..';
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
                                {(airportName || hasStormGlass) && <span className="text-white/30">•</span>}
                            </>
                        )}
                        {airportName && (
                            <>
                                <span className="text-amber-400 font-bold">{shortenSourceName(airportName)}</span>
                                {hasStormGlass && <span className="text-white/30">•</span>}
                            </>
                        )}
                        {hasStormGlass && (
                            <span className="text-red-400 font-bold">SG</span>
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
