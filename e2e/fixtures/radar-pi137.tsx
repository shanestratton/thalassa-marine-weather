/** No hardware/relay claim: generated reports, actual rule/decoder/controller and real UI. */
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { PiRadarWatchControls, PiRadarAlarmCards } from '../../components/map/PiRadarWatchControls';
import { PiRadarWatchController } from '../../services/radar/piRadarWatchState';
import { decodePiRadarWatch } from '../../services/radar/piRadarWatchWire';
import { decodeRadarCloudSnapshot } from '../../services/radar/piRadarCloud';
import { RadarEncounters } from '../../utils/radarEncounters';
import { RadarFeed } from '../../utils/radarFeed';
import { gradeRadarContact } from '../../utils/radarCollision';
import { radarRelayKeyCanonical } from '../../utils/radarRelayContract';
import { DEFAULT_COLLISION_PREFS } from '../../utils/collisionRule';
import fixture from '../../tests/fixtures/radar-relay137.json';
if (!import.meta.env.DEV) throw Error('Development fixture only');
const b = fixture.context.binding,
    model = new RadarEncounters(fixture.context.watchEpoch);
let armed = false,
    cloud = false,
    unavailable = false,
    active = true,
    original = Date.now();
const calls = { arm: 0, off: 0, ack: 0, read: 0 };
const frame = (body: string) =>
    '$' +
    body +
    '*' +
    [...body]
        .reduce((a, c) => a ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0');
function generate(range: number) {
    original = Date.now();
    const d = new Date(original),
        utc = d.toISOString().slice(11, 23).replaceAll(':', ''),
        day =
            String(d.getUTCDate()).padStart(2, '0') +
            String(d.getUTCMonth() + 1).padStart(2, '0') +
            String(d.getUTCFullYear()).slice(-2),
        feed = new RadarFeed('pi:' + 'a'.repeat(32));
    for (const body of [
        `GPRMC,${utc},A,0000.000,N,00000.000,E,5,0,${day},,,A`,
        'HEHDT,0,T',
        `RATTM,1,${range},0,R,10,180,R,0,6,N,Generated <img src=x> radar,T,,${utc},A`,
    ])
        feed.ingest(frame(body), original, original);
    const candidate = gradeRadarContact(feed.contacts(original)[0], feed.ownshipSnapshot(), original)!;
    model.update([candidate], () => 'moving', original);
}
async function raw() {
    const alarms = [];
    for (const card of armed ? model.cards(Date.now()) : []) {
        const kind = card.closeQuarters ? 'radar-close-quarters' : 'radar-collision';
        const digest = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(radarRelayKeyCanonical(fixture.context, { ...card, kind })),
        );
        const key =
            kind +
            ':' +
            Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0'))
                .join('')
                .slice(0, 12) +
            ':' +
            card.raisedAt;
        alarms.push({ ...card, key });
    }
    return {
        schema: 1,
        update: 7,
        capability: 1,
        servedAt: Date.now(),
        evaluatedAt: armed ? Date.now() : null,
        contextRevision: 1,
        context: armed ? fixture.context : null,
        owner: { ownerId: b.ownerId, piDeviceId: b.piDeviceId, pairingId: b.pairingId, feedId: b.feedId },
        ownerRevision: 'a'.repeat(64),
        configured: true,
        running: armed,
        state: armed ? 'armed' : 'off',
        prefs: armed ? DEFAULT_COLLISION_PREFS : null,
        alarms,
        more: false,
        capacity: null,
        push: { state: 'unavailable', checkedAt: null },
    };
}
async function proof() {
    if (unavailable) throw Error('Generated LAN unavailable');
    const packet = await raw();
    if (cloud) {
        const result = await decodeRadarCloudSnapshot(
            {
                schema: 1,
                checkedAt: Date.now(),
                owner: packet.owner,
                context: fixture.context,
                contextRevision: fixture.context.instance,
                retired: !armed,
                evaluatedAt: armed ? Date.now() : null,
                more: false,
                alarms: packet.alarms.map((c) => ({
                    key: c.key,
                    contactKey: c.contactKey,
                    episodeId: c.episodeId,
                    kind: c.closeQuarters ? 'radar-close-quarters' : 'radar-collision',
                    raisedAt: c.raisedAt,
                    sourceAt: c.sourceAt,
                    reportAt: c.reportAt,
                    cpaNm: c.assessment.cpaNm,
                    tcpaMin: c.assessment.tcpaMin,
                    rangeNm: c.assessment.rangeNm,
                    bearingDeg: c.assessment.bearingDeg,
                    lost: c.lost?.reason ?? null,
                    ackedAt: null,
                })),
            },
            Date.now(),
        );
        if (!result) throw Error('Generated cloud snapshot rejected');
        return { ...result, deviceId: '', isCurrent: () => active, source: 'cloud' as const };
    }
    const view = await decodePiRadarWatch(packet, Date.now());
    if (!view) throw Error('Generated status rejected');
    return { view, deviceId: b.deviceId, isCurrent: () => active };
}
const state = new PiRadarWatchController({
    read: async () => {
        calls.read++;
        return proof();
    },
    arm: async () => {
        calls.arm++;
        armed = true;
        generate(1);
        return proof();
    },
    off: async () => {
        calls.off++;
        armed = false;
        return proof();
    },
    ack: async (p, key) => {
        calls.ack++;
        const card = (await raw()).alarms.find((c) => c.key === key);
        if (card)
            model.acknowledge(
                { ...card, kind: card.closeQuarters ? 'radar-close-quarters' : 'radar-collision' },
                Date.now(),
            );
        return proof();
    },
    review: proof,
    shield: () => true,
    prefs: () => DEFAULT_COLLISION_PREFS,
    now: Date.now,
});
Object.assign(window, {
    __radarPi137: {
        calls,
        lost: async () => {
            unavailable = true;
            await state.refresh();
        },
        escalate: async () => {
            unavailable = false;
            cloud = false;
            generate(0.04);
            await state.refresh();
        },
        ashore: async () => {
            unavailable = false;
            cloud = true;
            await state.refresh();
        },
        retire: () => {
            active = false;
            state.get();
        },
        original: () => original,
    },
});
function App() {
    const snapshot = useSyncExternalStore(state.subscribe, state.get),
        [now, setNow] = useState(Date.now);
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);
    return (
        <main className="fixed inset-0 overflow-auto bg-slate-950 p-3 text-white">
            <div className="mx-auto flex max-w-md flex-col gap-3">
                <h1 className="text-base font-bold">Generated paired radar controls</h1>
                <PiRadarWatchControls controller={state} paired />
                <PiRadarAlarmCards state={snapshot} now={now} acknowledge={(key) => state.acknowledge(key)} />
                <p className="text-xs">
                    Synthetic standards fixture. No physical radar, Pi, provider or cloud connection.
                </p>
            </div>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<App />);
