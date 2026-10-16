/** Generated standards evidence only; actual parser, shared rule, episode store and global alarm cards. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { AisGuardAlert } from '../../components/map/AisGuardAlert';
import { RadarAlarmStore } from '../../services/radar/radarAlarmStore';
import { RadarFeed } from '../../utils/radarFeed';
import { gradeRadarContact } from '../../utils/radarCollision';
if (!import.meta.env.DEV) throw Error('Development fixture only');
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
RadarAlarmStore.setArmed(true);
function generate(range: number) {
    const now = Date.now(),
        date = new Date(now),
        utc = date.toISOString().slice(11, 23).replaceAll(':', ''),
        day =
            String(date.getUTCDate()).padStart(2, '0') +
            String(date.getUTCMonth() + 1).padStart(2, '0') +
            String(date.getUTCFullYear()).slice(-2);
    const feed = new RadarFeed('gateway:generated');
    for (const body of [
        `GPRMC,${utc},A,0000.000,N,00000.000,E,5,0,${day},,,A`,
        'HEHDT,0,T',
        `RATTM,1,${range},0,R,10,180,R,0,6,N,Generated <img src=x> target,T,,${utc},A`,
    ])
        feed.ingest(frame(body), now, now);
    const candidate = gradeRadarContact(feed.contacts(now)[0], feed.ownshipSnapshot(), now)!;
    RadarAlarmStore.update([candidate], () => 'moving', { feeds: 1, qualifiedFeeds: 1 }, now);
}
generate(1);
const first = RadarAlarmStore.get().cards[0];
Object.assign(window, {
    __radarAlarm137: {
        oldAck: () => RadarAlarmStore.acknowledge({ ...first, kind: 'radar-collision' }),
        lost: () => RadarAlarmStore.update([], () => 'no-fix', { feeds: 0, qualifiedFeeds: 0 }),
    },
});
createRoot(document.getElementById('root')!).render(
    <main className="fixed inset-0 bg-slate-950 text-white">
        <AisGuardAlert />
        <button
            className="absolute bottom-6 left-4 min-h-11 rounded-lg border border-white/30 p-2"
            onClick={() => generate(0.04)}
        >
            Generate close quarters
        </button>
    </main>,
);
