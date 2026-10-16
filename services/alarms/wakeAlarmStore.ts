import { WAKE_PRESETS, wakePresetPriority, type WakePreset, type WakeReading } from '../../utils/wakeRule';
import type { WakeCloudAlarmRef } from './wakeAlarmAcknowledgement';
export interface WakeAlarmCard {
    preset: WakePreset;
    status: string;
    value: number | null;
    quiet: boolean;
    muted: boolean;
    acknowledged?: boolean;
    cloud?: WakeCloudAlarmRef;
    sourceAt?: number;
    depthBasis?: WakeReading['depthBasis'];
}
let cards: readonly WakeAlarmCard[] = [];
let local: readonly WakeAlarmCard[] = [],
    cloud: readonly WakeAlarmCard[] = [];
let expiry: ReturnType<typeof setTimeout> | null = null;
let cloudCurrent = () => true;
const listeners = new Set<() => void>();
function publish() {
    const next = [...local, ...cloud.filter((c) => !local.some((l) => l.cloud?.key === c.cloud?.key))].sort(
        (a, b) => wakePresetPriority(a.preset) - wakePresetPriority(b.preset),
    );
    if (JSON.stringify(cards) === JSON.stringify(next)) return;
    cards = Object.freeze(next.map((r) => Object.freeze({ ...r })));
    for (const listener of [...listeners])
        try {
            listener();
        } catch {
            console.error('[WakeAlarmStore] subscriber failed');
        }
}
function expireCloud() {
    if (expiry) clearTimeout(expiry);
    expiry = null;
    const now = Date.now();
    if (!cloudCurrent()) cloud = [];
    let delay = Infinity;
    cloud = cloud.map((c) => {
        if (c.sourceAt === undefined || now < c.sourceAt - 1000 || now - c.sourceAt > WAKE_PRESETS[c.preset].maxAge)
            return { ...c, status: 'unknown', value: null };
        delay = Math.min(delay, c.sourceAt + WAKE_PRESETS[c.preset].maxAge + 1 - now);
        return c;
    });
    publish();
    if (cloud.length)
        expiry = setTimeout(expireCloud, Number.isFinite(delay) ? Math.max(1, Math.min(delay, 1000)) : 1000);
}
export const WakeAlarmStore = {
    get: () => cards,
    subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },
    publish: (next: readonly WakeAlarmCard[]) => {
        local = next;
        publish();
    },
    publishCloud: (next: readonly WakeAlarmCard[], isCurrent: () => boolean = () => true) => {
        cloud = next;
        cloudCurrent = isCurrent;
        expireCloud();
    },
    acknowledge: async (ref: WakeCloudAlarmRef) => {
        const result = await (await import('./wakeAlarmAcknowledgement')).acknowledgeWakeAlarm(ref);
        if (result) {
            cloud = cloud.filter((c) => c.cloud?.key !== ref.key);
            publish();
        }
        return result;
    },
    mute: () => {
        void import('./WakeRuleWatch').then(({ WakeRuleWatch }) => WakeRuleWatch.mute());
    },
};
