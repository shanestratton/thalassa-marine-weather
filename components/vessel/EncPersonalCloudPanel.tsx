/**
 * Charts, in Settings → System & Cloud: one plain line, nothing to press.
 *
 * Until build 126 this card offered "Publish N charts" and "Keep new charts
 * published", which copied decrypted licensed charts to the skipper's own
 * cloud folder so a browser could draw them. o-charts (Roberto, 2026-10-10):
 * "Storing unencrypted data on any medium, and especially in the cloud, is
 * strictly prohibited by the terms of the licenses signed with the chart
 * providers." So licensed charts stay on the boat's Pi and, from 127, open in
 * the phone's memory only (127-C-c); the card says so in one line and reads
 * nothing from the cloud to say it.
 *
 * The line claims only what Thalassa does. Device backups made before 127 may
 * still hold the old chart folder until the skipper deletes them, so "never
 * copied to the cloud" is still not a promise this card makes.
 */

import React from 'react';

export const EncPersonalCloudPanel: React.FC = () => (
    <div className="rounded-xl border border-white/8 bg-white/3 p-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-white/60">Charts</p>
        <p className="mt-1 text-[11px] leading-snug text-white/45">
            Licensed charts stay on your boat's Pi and open in this device's memory only. Thalassa never uploads them to
            its servers.
        </p>
    </div>
);
