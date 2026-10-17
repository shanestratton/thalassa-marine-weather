import React from 'react';
import { createRoot } from 'react-dom/client';
import PairedPiSignalKCard from '../../components/vessel/PairedPiSignalKCard';
import { SignalKNotifications } from '../../components/vessel/SignalKNotifications';
import '../../index.css';

// Real reader and shared display, fictional notification only. Browser transport
// is unavailable; the button must refuse it without opening any network fallback.
const at = Date.now() - 2500;
createRoot(document.getElementById('root')!).render(
    <main className="h-dvh overflow-y-auto bg-slate-950 p-3 pb-24 text-white">
        <PairedPiSignalKCard />
        <section aria-label="Fictional notification example" className="rounded-xl bg-slate-900 p-3">
            <p className="mb-3 text-xs">Fictional source-dated notification display</p>
            <SignalKNotifications
                source="Paired Pi"
                notices={[
                    {
                        path: 'notifications.depth.transducer.belowKeel',
                        source: 'fictional-receiver.1',
                        at,
                        receivedAt: at + 100,
                        message: 'Fictional depth alarm: check the boat instrument and its stated depth reference.',
                        state: 'alarm',
                        soundRequested: true,
                    },
                ]}
            />
        </section>
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-900 h-16 bg-slate-900" />
    </main>,
);
