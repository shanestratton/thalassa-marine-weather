/**
 * ConnectivityChip — at-a-glance network status for the chart screen.
 *
 * Marine users need to know what they're connected to and what it
 * costs them. Three states:
 *
 *   🟢 Pi          — boat-network Pi-Cache reachable. Best state:
 *                    cached tiles, fleet-shared fetches, no cellular cost.
 *   🟡 Online      — cellular or WiFi internet but no Pi. Fetches go
 *                    direct to upstream — burns cellular data.
 *   🔴 Offline     — no network. Cached tiles only; live feeds (lightning,
 *                    cyclones) won't update.
 *
 * Sits at the bottom-right of the chart, above the scale bar. Tappable
 * (future: open the boat-network settings sheet). Polls every 5s
 * because Pi reachability + cellular state can flip without notice
 * (e.g. boat moves out of WiFi range).
 *
 * Designed to be ignorable in steady state but alarming when offline —
 * red dot with subtle pulse so the user notices their data is stale.
 */
import React, { useEffect, useState } from 'react';
import { piCache } from '../../services/PiCacheService';

type Connectivity = 'pi' | 'online' | 'offline';

interface ConnectivityChipProps {
    visible: boolean;
}

const POLL_INTERVAL_MS = 5_000;

function detect(): Connectivity {
    if (piCache.isAvailable()) return 'pi';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    return 'online';
}

export const ConnectivityChip: React.FC<ConnectivityChipProps> = ({ visible }) => {
    const [state, setState] = useState<Connectivity>(() => detect());

    useEffect(() => {
        if (!visible) return;
        const tick = () => setState(detect());
        tick();
        const t = setInterval(tick, POLL_INTERVAL_MS);
        // Also react to the browser's online/offline events for instant
        // updates when the user toggles airplane mode.
        const onOnline = () => tick();
        const onOffline = () => tick();
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => {
            clearInterval(t);
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
        };
    }, [visible]);

    if (!visible) return null;

    const STYLES: Record<Connectivity, { dot: string; label: string; tooltip: string }> = {
        pi: {
            dot: 'bg-emerald-400',
            label: 'Pi',
            tooltip: 'Boat-network Pi cache — cached tiles, fleet-shared fetches',
        },
        online: {
            dot: 'bg-amber-400',
            label: 'Online',
            tooltip: 'Cellular or WiFi — fetches go direct to upstream (cellular data may apply)',
        },
        offline: {
            dot: 'bg-red-400 animate-pulse',
            label: 'Offline',
            tooltip: 'No network — only cached data is available; live feeds will not update',
        },
    };
    const s = STYLES[state];

    return (
        <div
            // Bottom-right, above the Mapbox scale control which sits at
            // bottom-right by default. z high enough to clear the chip
            // backdrop but below the modal layer.
            // right-[16px] aligns this chip with the right-rail FAB column
            // (Layer/Offline/Vessel Search at top-[80/144/208]) and the
            // bottom-right MapActionFabs (right-4 = also 16px). Every right-
            // edge element on the chart now sits on the same vertical gridline.
            className="fixed right-[16px] z-[140] pointer-events-auto chart-chip-up"
            style={{ bottom: 'max(40px, calc(env(safe-area-inset-bottom) + 32px))' }}
            title={s.tooltip}
        >
            <div
                className="flex items-center gap-1.5 text-[10px] leading-tight font-semibold"
                style={{
                    background: 'rgba(15, 23, 42, 0.78)',
                    backdropFilter: 'blur(12px)',
                    WebkitBackdropFilter: 'blur(12px)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 12,
                    padding: '4px 8px',
                    color: 'rgba(255,255,255,0.85)',
                }}
            >
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />
                <span className="tracking-wide">{s.label}</span>
            </div>
        </div>
    );
};
