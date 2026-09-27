/**
 * SmartPolarsSetting — the Smart Polars switch, in Settings → Preferences.
 *
 * It moved off the Polars page, which keeps a one-line state and a link here
 * (UX scorecard run 8; Shane 2026-09-09: switches live in Preferences). Same
 * setting (smartPolarsEnabled) and the same effect the page's switch had: on
 * asks the instrument policy for a feed and starts the learner; off stops the
 * learner and the direct NMEA listener. With no NMEA feed it cannot turn on;
 * the line under it says so and links to the gateway, as the page did.
 */
import React, { useEffect, useId, useState } from 'react';
import { InstrumentSourcePolicy } from '../../services/InstrumentSourcePolicy';
import { NmeaListenerService, type NmeaConnectionStatus } from '../../services/NmeaListenerService';
import { NmeaStore } from '../../services/NmeaStore';
import { SmartPolarService } from '../../services/SmartPolarService';
import { Row, Toggle } from './SettingsPrimitives';
import type { UserSettings } from '../../types';

/** Turns the learner on or off exactly as the Polars page's switch used to. */
export function applySmartPolars(enabled: boolean, feed: { host?: string; port?: number }): void {
    if (enabled) {
        // The policy decides the feed: with a Pi paired this is the LAN
        // lane, and no socket opens (Shane 2026-09-08).
        InstrumentSourcePolicy.ensureFeed({
            host: feed.host || '192.168.1.1',
            port: feed.port || 10110,
        });
        void SmartPolarService.start();
    } else {
        SmartPolarService.stop();
        NmeaStore.stop();
        NmeaListenerService.stop();
    }
}

const openNmeaGateway = () => window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: 'nmea' } }));

export const SmartPolarsSetting: React.FC<{
    settings: UserSettings;
    onSave: (patch: Partial<UserSettings>) => void;
}> = ({ settings, onSave }) => {
    const enabled = settings.smartPolarsEnabled === true;
    const [nmeaStatus, setNmeaStatus] = useState<NmeaConnectionStatus>(() => NmeaListenerService.getStatus());
    useEffect(() => {
        const unsubscribe = NmeaListenerService.onStatusChange(setNmeaStatus);
        setNmeaStatus(NmeaListenerService.getStatus());
        return () => {
            unsubscribe();
        };
    }, []);
    const captionId = useId();
    // Same rule the Polars page used: off, with no feed, it cannot turn on.
    const blocked = !enabled && nmeaStatus === 'disconnected';

    return (
        <Row>
            <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-medium">Smart Polars</p>
                <p id={captionId} className="text-xs text-gray-400">
                    {blocked ? (
                        <>
                            Needs your instruments’ NMEA feed.{' '}
                            <button
                                type="button"
                                onClick={openNmeaGateway}
                                className="inline-flex min-h-11 items-center font-bold text-sky-300 underline underline-offset-2"
                            >
                                Set up NMEA gateway
                            </button>
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
                        applySmartPolars(on, { host: settings.nmeaHost, port: settings.nmeaPort });
                        onSave({ smartPolarsEnabled: on });
                    }}
                />
            )}
        </Row>
    );
};
