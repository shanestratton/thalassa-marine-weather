import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import OwnBoatSkill from '../../components/dashboard/OwnBoatSkill';
import { ModalSheet } from '../../components/ui/ModalSheet';
import type { PrivateBoatSession } from '../../services/weather/ownBoatSkillTransaction';
import { scoreOwnWind } from '../../pi-cache/src/ownBoatSkill/score';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Development fixture only');
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const binding = {
    ownerId: ID,
    vesselId: ID,
    vesselRevision: 1,
    piDeviceId: ID,
    controllerId: ID,
    pairingRevision: 'a'.repeat(64),
    enrollmentRevision: 'b'.repeat(64),
    selfKey: 'c'.repeat(64),
    windSourceKey: 'd'.repeat(64),
    positionSourceKey: 'e'.repeat(64),
};
let requests = 0;
const count = () => {
    document.documentElement.dataset.privateRequests = String(++requests);
};
function session(): PrivateBoatSession {
    let saved = false,
        logging = false,
        current = true;
    return {
        vesselName: 'Synthetic boat',
        get saved() {
            return saved;
        },
        current: () => current,
        prepare: async () => {
            count();
            return {
                schema: 1,
                nonce: 'f'.repeat(64),
                expiresAt: Date.now() + 60_000,
                binding,
                vesselName: 'Synthetic boat with a deliberately long display name',
                windSource: 'synthetic.instrument.true-wind.receiver-long-name',
                positionSource: 'synthetic.position.receiver-long-name',
            };
        },
        confirm: async (value) => {
            count();
            saved = true;
            logging = value;
            return {
                schema: 1,
                capability: '1'.repeat(64),
                consent: {
                    schema: 1,
                    revision: ID,
                    binding,
                    issuedAt: Date.now(),
                    expiresAt: Date.now() + 14 * 86400_000,
                },
            };
        },
        read: async () => {
            count();
            if (!saved) throw Error('Review private access first.');
            return {
                logging,
                phase: 'Warming; original forecasts and samples remain private.',
                generatedAt: Math.floor(Date.now() / 1000),
                lastMeasuredAt: null,
                scores: scoreOwnWind([], [], Date.now(), 'own:' + ID),
            };
        },
        off: async () => {
            count();
            saved = false;
            logging = false;
        },
        release: () => {
            current = false;
        },
        retire: () => {
            current = false;
        },
    };
}
document.documentElement.dataset.privateRequests = '0';
document.documentElement.style.fontSize = new URLSearchParams(location.search).get('large') === '1' ? '20.8px' : '16px';
document.body.style.cssText = 'height:100dvh;overflow:hidden;margin:0';
document.getElementById('root')!.style.height = '100%';
function Fixture() {
    const [open, setOpen] = useState(false);
    return (
        <main className="h-full overflow-hidden bg-slate-950 p-3 text-white">
            <p className="text-xs">
                Synthetic UI only. No account, instruments, private storage, provider or Pi request.
            </p>
            <button className="min-h-11 px-3" onClick={() => setOpen(true)}>
                Open private controls
            </button>
            <ModalSheet
                isOpen={open}
                onClose={() => setOpen(false)}
                title="Private boat scorecard"
                footer={
                    <button
                        className="min-h-11 w-full rounded-lg border border-white/15 px-3 py-2 text-white"
                        onClick={() => setOpen(false)}
                    >
                        Close private controls
                    </button>
                }
            >
                <OwnBoatSkill openReview={async () => session()} />
            </ModalSheet>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
