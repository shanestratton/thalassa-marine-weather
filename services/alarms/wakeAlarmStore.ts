import type { WakePreset } from '../../utils/wakeRule';
export interface WakeAlarmCard {
    preset: WakePreset;
    status: string;
    value: number | null;
    quiet: boolean;
    muted: boolean;
}
let cards: readonly WakeAlarmCard[] = [];
const listeners = new Set<() => void>();
export const WakeAlarmStore = {
    get: () => cards,
    subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },
    publish: (next: readonly WakeAlarmCard[]) => {
        if (JSON.stringify(cards) === JSON.stringify(next)) return;
        cards = Object.freeze(next.map((row) => Object.freeze({ ...row })));
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch {
                console.error('[WakeAlarmStore] subscriber failed');
            }
        }
    },
    mute: () => {
        void import('./WakeRuleWatch').then(({ WakeRuleWatch }) => WakeRuleWatch.mute());
    },
};
