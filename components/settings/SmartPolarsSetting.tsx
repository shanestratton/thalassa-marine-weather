/**
 * SmartPolarsSetting — the Smart Polars switch, in Settings → Preferences.
 *
 * It moved off the Polars page, which keeps a one-line state and a link here
 * (UX scorecard run 8; Shane 2026-09-09: switches live in Preferences). On asks
 * the instrument policy for a feed (the Pi's lane when one is paired, and then
 * no socket opens) and starts the learner.
 *
 * Build 126 (126-B6a, polars-01):
 * - It turns on with any boat link — a Pi paired or a gateway saved — not only
 *   with this phone's socket open, which never opens on a Pi boat.
 * - Off stops the learner and NOTHING else. It used to stop NmeaStore and the
 *   socket too, which emptied the Instrument Panel, took the boat's GPS from
 *   Anchor Watch and the Log, and cleared the AIS targets the collision alarm
 *   reads. The store and the socket are InstrumentSourcePolicy's.
 */
import React, { useEffect, useId, useState } from 'react';
import { InstrumentSourcePolicy } from '../../services/InstrumentSourcePolicy';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { getPairing } from '../../services/PiPairingService';
import { SmartPolarService } from '../../services/SmartPolarService';
import { learnerFeedState, subscribeLearnerFeedState } from '../../services/smartPolarFeed';
import { Row, Toggle } from './SettingsPrimitives';
import type { UserSettings } from '../../types';

/** On: the policy's feed and the learner. Off: the learner only. */
export function applySmartPolars(enabled: boolean): void {
    if (enabled) {
        // The policy decides the feed: with a Pi paired this is the LAN
        // lane, and no socket opens (Shane 2026-09-08). With no Pi, the
        // gateway the skipper saved — never a made-up default address, which
        // would re-aim every later reconnect away from the boat's gateway.
        InstrumentSourcePolicy.ensureFeed(NmeaListenerService.getSavedConfig() ?? undefined);
        void SmartPolarService.start();
    } else {
        SmartPolarService.stop();
    }
}

/**
 * Any way to the boat's instruments: a Pi paired or a gateway saved. 126-10a's
 * boatLinkConfigured() (services/boatLink/boatLinkGate) answers the same
 * question; use it once it lands.
 */
const hasBoatLink = (): boolean => getPairing() !== null || NmeaListenerService.getSavedConfig() !== null;

const openNmeaGateway = () => window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: 'nmea' } }));

export const SmartPolarsSetting: React.FC<{
    settings: UserSettings;
    onSave: (patch: Partial<UserSettings>) => void;
}> = ({ settings, onSave }) => {
    const enabled = settings.smartPolarsEnabled === true;
    // Re-read the link whenever the feed changes (a gateway connecting, the
    // Pi's lane starting), so a link set up while this page is open counts.
    const [, setFeed] = useState(learnerFeedState);
    useEffect(() => {
        setFeed(learnerFeedState());
        return subscribeLearnerFeedState(setFeed);
    }, []);
    const captionId = useId();
    // Off, with no way to the boat's instruments, it cannot turn on.
    const blocked = !enabled && !hasBoatLink();

    return (
        <Row>
            <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-medium">Smart Polars</p>
                <p id={captionId} className="text-xs text-gray-400">
                    {blocked ? (
                        <>
                            Needs your boat’s instruments: pair the Pi, or{' '}
                            <button
                                type="button"
                                onClick={openNmeaGateway}
                                className="inline-flex min-h-11 items-center font-bold text-sky-300 underline underline-offset-2"
                            >
                                set up an NMEA gateway
                            </button>
                            .
                        </>
                    ) : (
                        'Learns your boat’s real performance from the instruments. The Polars page shows what it has learned.'
                    )}
                </p>
            </div>
            {blocked ? (
                <button
                    type="button"
                    role="switch"
                    aria-checked={false}
                    aria-label="Smart Polars"
                    aria-describedby={captionId}
                    disabled
                    className="relative inline-flex items-center py-2.5 px-2 -mr-2 cursor-not-allowed"
                >
                    <div className="w-11 h-6 rounded-full bg-slate-700 opacity-50" aria-hidden="true">
                        <div className="absolute top-3.5 left-3 w-4 h-4 bg-white rounded-full" />
                    </div>
                </button>
            ) : (
                <Toggle
                    checked={enabled}
                    label="Smart Polars"
                    onChange={(on) => {
                        applySmartPolars(on);
                        onSave({ smartPolarsEnabled: on });
                    }}
                />
            )}
        </Row>
    );
};
