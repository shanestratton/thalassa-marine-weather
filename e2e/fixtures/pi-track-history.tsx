/** Real UI/map/export with generated rows in place of the unavailable native private TLS bridge. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import PiTrackHistorySheet from '../../components/settings/PiTrackHistorySheet';
import { PiTrackHistoryError, type PiTrackHistoryPoint } from '../../services/piTrackHistory';
import type { loadPiTrackHistory } from '../../services/piTrackHistory';

if (!import.meta.env.DEV) throw new Error('Development fixture only');
const params = new URLSearchParams(location.search);
let calls = 0;
Object.assign(window, {
    __trackHistoryFixture: {
        get calls() {
            return calls;
        },
    },
});
const to = Date.parse('2026-01-02T00:00:00Z');
const readHistory: typeof loadPiTrackHistory = async ({ from, to, cursor, signal }) => {
    calls++;
    if (params.has('legacy')) throw new PiTrackHistoryError('update');
    if (params.has('pending'))
        return new Promise((_, reject) =>
            signal?.addEventListener('abort', () => reject(new PiTrackHistoryError('cancelled')), { once: true }),
        );
    const count = cursor ? 1 : params.has('many') ? 10_000 : 4;
    const points: PiTrackHistoryPoint[] = Array.from({ length: count }, (_, index) => ({
        sample_id: cursor ? 5 : index + 1,
        at_ms: cursor
            ? to
            : count === 4
              ? [from, from + 120_000, to - 120_000, to][index]
              : Math.round(from + ((to - from) * index) / Math.max(1, count - 1)),
        lat: -17.1 - index * 0.000001,
        lon: index % 2 ? -179.9 : 179.9,
        reason: 'first',
        sog_kts: index % 3 ? 5 : 0,
        cog_deg: 90,
        stw_kts: null,
        hdg_deg: null,
        depth_m: index === 1 ? null : 8,
        tws_kts: index === 1 ? null : 12,
        twd_deg: 0,
        water_temp_c: null,
        pressure_hpa: null,
        heel_deg: index === 1 ? null : -6,
        engine_rpm: null,
        twa_deg: null,
    }));
    const partial = params.has('partial');
    return {
        from,
        to,
        points,
        truncated: partial,
        snapshot: Math.max(count, 5),
        nextCursor: partial && !cursor ? `${points.at(-1)!.at_ms}:${count}:5` : null,
    };
};
function Fixture() {
    const [open, setOpen] = useState(false);
    return (
        <main className="min-h-screen bg-slate-950 p-4 text-white">
            <button
                className="min-h-11 rounded-lg border p-3"
                onClick={(event) => {
                    event.currentTarget.focus({ preventScroll: true });
                    setOpen(true);
                }}
            >
                Open boat track
            </button>
            {open && <PiTrackHistorySheet onClose={() => setOpen(false)} lastMs={to} readHistory={readHistory} />}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
