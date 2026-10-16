/** Actual recovery controls with fictional retained status; no Pi, cloud, audio or provider calls. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { WakePiControls } from '../../components/settings/WakePiControls';
import { WakeRuleWatch, type WakeRuleView } from '../../services/alarms/WakeRuleWatch';
import { defaultWakeRules } from '../../utils/wakeRule';
if (!import.meta.env.DEV) throw Error('Development fixture only');
const binding = {
        ownerId: '11111111-1111-4111-8111-111111111111',
        piDeviceId: '22222222-2222-4222-8222-222222222222',
        pairingId: 'a'.repeat(64),
        deviceId: '33333333-3333-4333-8333-333333333333',
        enrollmentRevision: 'b'.repeat(64),
        feedId: `pi:22222222-2222-4222-8222-222222222222:${'c'.repeat(24)}`,
    },
    rules = defaultWakeRules();
rules[0] = {
    ...rules[0],
    enabled: true,
    selection: { feedId: binding.feedId, sensorId: 'fictional.depth', reference: 'below-keel' },
};
rules[1] = {
    ...rules[1],
    enabled: true,
    selection: { feedId: binding.feedId, sensorId: 'fictional.wind', reference: 'true-water' },
    quietHours: { startMinute: 1320, endMinute: 360, utcOffsetMinutes: 600 },
};
let view: WakeRuleView = {
    state: 'watching',
    keeper: 'phone-only',
    busy: false,
    muted: false,
    rules: [],
    pi: {
        schema: 1,
        update: 7,
        instance: '55555555-5555-4555-8555-555555555555',
        binding,
        configured: true,
        running: true,
        reason: 'awaiting-sensors',
        proof: null,
        rules: [],
        configuration: {
            schema: 1,
            revision: '44444444-4444-4444-8444-444444444444',
            binding,
            rules,
            rulesDigest: 'd'.repeat(64),
            draftM: null,
            configuredAt: Date.now(),
        },
        pressure: { state: 'unavailable', sampleCount: 0, spanMs: 0 },
        servedAt: Date.now(),
        push: {
            state: 'conflict',
            capability: 0,
            checkedAt: Date.now(),
            conflict: {
                revision: '66666666-6666-4666-8666-666666666666',
                configurationRevision: '77777777-7777-4777-8777-777777777777',
                rulesDigest: 'e'.repeat(64),
                feedMatches: false,
                retired: false,
                rules: rules.map((r) => ({
                    preset: r.preset,
                    enabled: r.enabled,
                    threshold: r.enabled ? r.threshold : null,
                    sourceMatches: false,
                    quietHours: r.quietHours,
                })),
            },
        },
    },
};
const listeners = new Set<() => void>();
WakeRuleWatch.getSnapshot = () => view;
WakeRuleWatch.subscribe = (listener) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
function Fixture() {
    const [reviews, setReviews] = useState(0);
    WakeRuleWatch.reviewPiRelay = async () => {
        setReviews((n) => n + 1);
        return true;
    };
    return (
        <main className="min-h-screen bg-slate-950 p-3 text-white">
            <WakePiControls />
            <output aria-label="Fictional review requests">{reviews}</output>
            <button
                type="button"
                onClick={() => {
                    const pi = view.pi!;
                    view = {
                        ...view,
                        pi: {
                            ...pi,
                            configuration: { ...pi.configuration!, revision: '88888888-8888-4888-8888-888888888888' },
                        },
                    };
                    for (const listener of listeners) listener();
                }}
            >
                Simulate changed Pi rules
            </button>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
