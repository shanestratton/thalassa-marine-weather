/**
 * VpnHairpinNotice — "you're aboard, but a VPN is routing you off the boat".
 *
 * One component, used anywhere the app talks to a device by its boat-LAN
 * address. The failure it names is not hypothetical: it made a healthy NMEA
 * gateway look broken for a day (2026-08-08), and it will do the same to chart
 * tiles and the Pi cache, because the cause is the route rather than the
 * service.
 *
 * Only appears when BOTH halves are true — same subnet AND a live tunnel. A
 * VPN on its own is how the boat is reached from ashore, and warning about
 * that would train the skipper to ignore this banner.
 */
import React from 'react';
import { assessHostRoute } from '../../services/network/networkContext';

interface VpnHairpinNoticeProps {
    /** The boat device being addressed, e.g. the gateway's IP. */
    hostIp: string | null;
    /** What to call it: "the NMEA gateway", "the Pi cache". */
    hostLabel: string;
    className?: string;
}

export const VpnHairpinNotice: React.FC<VpnHairpinNoticeProps> = ({ hostIp, hostLabel, className = '' }) => {
    const [warning, setWarning] = React.useState<string | null>(null);

    React.useEffect(() => {
        let alive = true;
        if (!hostIp) {
            setWarning(null);
            return;
        }
        const check = () => {
            void assessHostRoute(hostIp, hostLabel).then((result) => {
                if (alive) setWarning(result.warning);
            });
        };
        check();
        // Toggling the VPN is exactly what we're asking the skipper to do, so
        // the banner has to notice them doing it and clear itself.
        const timer = setInterval(check, 20_000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [hostIp, hostLabel]);

    if (!warning) return null;

    return (
        <div
            role="status"
            className={`rounded-xl border border-amber-500/25 bg-linear-to-br from-amber-500/10 via-amber-500/4 to-transparent p-3 ${className}`}
        >
            <div className="flex items-start gap-2.5">
                <span className="mt-px text-base leading-none" aria-hidden="true">
                    🔀
                </span>
                <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-black uppercase tracking-widest text-amber-300">
                        VPN may be routing you off the boat
                    </div>
                    <p className="mt-1 text-[12px] leading-snug text-gray-300">{warning}</p>
                </div>
            </div>
        </div>
    );
};

VpnHairpinNotice.displayName = 'VpnHairpinNotice';
