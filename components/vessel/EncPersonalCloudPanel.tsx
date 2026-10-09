/**
 * Charts, in Settings → System & Cloud: one plain line, nothing to press.
 *
 * Until build 126 this card offered "Publish N charts" and "Keep new charts
 * published", which copied decrypted licensed charts to the skipper's own
 * cloud folder so a browser could draw them. o-charts (Roberto, 2026-10-10):
 * "Storing unencrypted data on any medium, and especially in the cloud, is
 * strictly prohibited by the terms of the licenses signed with the chart
 * providers." So licensed charts stay on the boat's Pi and the device that
 * synced them, the publish path is switched off (services/enc/personalCellSync
 * PERSONAL_CHART_CLOUD_ENABLED), and the card says so in one line. It reads
 * nothing from the cloud to say it. The old per-device Auto-publish flag is
 * cleared at launch (hooks/useAppBootstrap.ts).
 *
 * The line claims only what Thalassa does. The chart store still sits in
 * Documents, which iCloud Backup copies, until 127 moves it out and excludes
 * it from backup; "never copied to the cloud" waits for that.
 */

import React from 'react';

export const EncPersonalCloudPanel: React.FC = () => (
    <div className="rounded-xl border border-white/8 bg-white/3 p-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-white/60">Charts</p>
        <p className="mt-1 text-[11px] leading-snug text-white/45">
            Licensed charts stay on this device and your boat's Pi. Thalassa never uploads them to its servers.
        </p>
    </div>
);
