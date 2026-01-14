
import { RadioTowerIcon } from '../Icons';
import { Countdown } from './Countdown';

interface StatusBadgesProps {
    isLandlocked: boolean;
    locationName: string;
    displaySource: string;
    nextUpdate: number | null;
    fallbackInland?: boolean;
    stationId?: string;
}

export const StatusBadges: React.FC<StatusBadgesProps> = ({ isLandlocked, locationName, displaySource, nextUpdate, fallbackInland, stationId }) => {
    // BADGES Logic
    let statusBadgeLabel = "OFFSHORE";
    let statusBadgeColor = "bg-sky-500/20 text-sky-300 border-sky-500/30";

    if (isLandlocked || fallbackInland) {
        statusBadgeLabel = "INLAND";
        statusBadgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/30";
    } else if (locationName && !locationName.startsWith("Ocean Point")) {
        // Default to COASTAL for named locations, UNLESS it's an Ocean Point
        statusBadgeLabel = "COASTAL";
        statusBadgeColor = "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
    }

    let timerBadgeColor = "bg-blue-500/20 text-blue-300 border-blue-500/30";

    // CLEAN SOURCE LABEL
    const rawSource = displaySource ? displaySource.toLowerCase() : "";
    // REVERTED DEBUG FOR PRODUCTION FEEL
    const isSG = rawSource.includes('storm') || rawSource.includes('sg');
    const cleanSource = isSG ? "STORMGLASS PRO" : displaySource;

    // console.log(`[STATUS BADGE DEBUG] Raw: "${displaySource}", Clean: "${cleanSource}", StationID: "${stationId}"`);

    return (
        <div className="px-4 md:px-6 -mt-4 shrink-0 relative z-20">
            <div className="flex items-center justify-between gap-1 md:gap-2 w-full mb-0">
                {/* Coastal / Offshore Badge */}
                <div className={`px-2 py-1.5 rounded-lg border text-[9px] font-bold uppercase tracking-wider ${statusBadgeColor} bg-black/40`}>
                    {statusBadgeLabel}
                </div>

                {/* Source Badge (With Tick for Stormglass) */}
                <div className={`px-2 py-1.5 rounded-lg border text-[9px] font-bold uppercase tracking-wider ${isSG ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'} bg-black/40 flex-1 min-w-0 flex items-center justify-center gap-1 overflow-hidden`}>
                    <RadioTowerIcon className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate flex items-center gap-1">
                        {cleanSource}
                        {stationId && <span className="text-white opacity-90">• {stationId}</span>}
                    </span>
                </div>

                {/* Timer Badge */}
                <div className={`px-1.5 py-1.5 rounded-lg border text-[8px] font-bold uppercase tracking-wider ${timerBadgeColor} bg-black/40 flex items-center gap-1 min-w-[60px] justify-center`}>
                    {nextUpdate ? <Countdown targetTime={nextUpdate} /> : "LIVE"}
                </div>
            </div>
        </div>
    );
};
