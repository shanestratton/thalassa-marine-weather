/** Generated wake card, no paired boat/session; the real ACK path must fail before WAN. */
import React, { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { WakeAlarmCards } from '../../components/map/WakeAlarmCards';
import { WakeAlarmStore } from '../../services/alarms/wakeAlarmStore';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
if (!import.meta.env.DEV) throw Error('Development fixture only');
const owner = '00000000-0000-4000-8000-000000000001';
setAuthIdentityScope(owner);
WakeAlarmStore.publishCloud([
    {
        preset: 'pressure-fall',
        status: 'unknown',
        value: null,
        quiet: false,
        muted: false,
        cloud: {
            ownerId: owner,
            piDeviceId: '00000000-0000-4000-8000-000000000002',
            contextRevision: '00000000-0000-4000-8000-000000000006',
            rulesDigest: 'c'.repeat(64),
            key: `wake-pressure:aaaaaaaaaaaa:${Date.now() - 121_001}`,
        },
        sourceAt: Date.now() - 120_001,
    },
]);
function Fixture() {
    const cards = useSyncExternalStore(WakeAlarmStore.subscribe, WakeAlarmStore.get);
    return (
        <main className="min-h-screen bg-slate-950 p-3 text-white">
            <WakeAlarmCards cards={cards} />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
