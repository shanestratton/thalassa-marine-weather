/** Real sheets and native IndexedDB; fictional signed-out fish/coordinates.
 * No provider, auth session, network, vessel or hardware. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development-only fictional fixture.');
localStorage.clear();
const { setAuthIdentityScope } = await import('../../services/authIdentityScope');
setAuthIdentityScope(null);
const { getLocalSighting } = await import('../../services/sightings/sightingStore');
const { logSighting, NO_VESSEL } = await import('../../services/sightings/sightingService');
const { insertPayload, updatePayload } = await import('../../services/sightings/sightingSync');
const { toDarwinCore } = await import('../../services/sightings/darwinCore');
const { itemFromLocal } = await import('../../components/sightings/sightingsFormat');
const { SightingDetail } = await import('../../components/sightings/SightingDetail');
const { SunMoonSheet } = await import('../../components/dashboard/SunMoonSheet');
const id = '14000000-0000-4000-8000-000000000006';
const record =
    (await getLocalSighting(id, null)) ??
    (await logSighting({
        id,
        group: 'fish',
        context: null,
        vessel: NO_VESSEL,
        visibility: 'private',
        eventAt: Date.now(),
    }));
const session = {
    userId: null,
    ownBoatId: null,
    ownBoatName: null,
    crewing: null,
    crewVessels: [],
    ownCrewCount: null,
};
Object.assign(window, {
    __solunarCatchFixture: {
        fence: () => setAuthIdentityScope('fictional-other-account'),
        snapshot: async () => {
            const row = await getLocalSighting(id, null);
            return row
                ? {
                      record: row,
                      sharedInsert: insertPayload(row),
                      sharedPatch: updatePayload(row),
                      export: toDarwinCore(row.row),
                  }
                : null;
        },
    },
});
function Fixture() {
    const [open, setOpen] = useState<'sun' | 'catch' | null>(null),
        [current, setCurrent] = useState(record);
    return (
        <main className="h-dvh overflow-hidden bg-slate-950 p-3 text-white">
            <p>Fictional local-only Solunar and catch log</p>
            <button className="min-h-[44px] p-2" onClick={() => setOpen('sun')}>
                Open Sun and moon
            </button>
            <button
                className="min-h-[44px] p-2"
                onClick={() =>
                    void getLocalSighting(id, null).then((row) => {
                        if (row) {
                            setCurrent(row);
                            setOpen('catch');
                        }
                    })
                }
            >
                Open private catch
            </button>
            {open === 'sun' && (
                <SunMoonSheet
                    onClose={() => setOpen(null)}
                    lat={-27.2}
                    lon={153.1}
                    timeZone="Australia/Brisbane"
                    isoDate="2026-10-17"
                    isToday={false}
                />
            )}
            {open === 'catch' && (
                <SightingDetail
                    item={itemFromLocal(current)}
                    session={session}
                    catalogue={null}
                    onClose={() => setOpen(null)}
                />
            )}
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
