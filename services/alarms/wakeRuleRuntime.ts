import { useSettingsStore } from '../../stores/settingsStore';
import { draftConfirmation } from '../draftConfirmation';
import { subscribeAuthIdentityScope } from '../authIdentityScope';
import { getWakeRulePreferences, subscribeWakeRulePreferences } from './wakeRulePreferences';
import { WakeRuleWatch } from './WakeRuleWatch';

function context() {
    const state = useSettingsStore.getState(),
        draft = draftConfirmation(state.settings.vessel);
    const metres = draft.status === 'confirmed' && draft.draftM !== null && draft.draftM <= 20 ? draft.draftM : null;
    return { key: JSON.stringify([state.activeVesselId, draft.status, metres]), draftM: metres };
}
/** User-requested discovery stays on the pinned boat LAN and never configures the Pi. */
export function readWakeRuleSensors() {
    const captured = context();
    return WakeRuleWatch.start(captured.draftM, () => context().key === captured.key);
}
/** Resume only saved, enabled phone rules. No background watch or automatic Pi mutation. */
export function startWakeRuleRuntime(): () => void {
    let live = true,
        last = context().key;
    const enabled = () => getWakeRulePreferences().rules.some((r) => r.enabled);
    const resume = () => {
        if (live && enabled() && document.visibilityState !== 'hidden') {
            void readWakeRuleSensors();
            void import('./wakeCloudAlarms')
                .then((m) => {
                    if (live) void m.refreshWakeCloudAlarms();
                })
                .catch(() => undefined);
        }
    };
    const preferences = subscribeWakeRulePreferences(() => {
        if (
            enabled() &&
            ['off', 'paused', 'unavailable', 'enrollment', 'update'].includes(WakeRuleWatch.getSnapshot().state)
        )
            resume();
    });
    const settings = useSettingsStore.subscribe(() => {
        const next = context().key;
        if (next !== last) {
            last = next;
            WakeRuleWatch.stop('paused', true);
            resume();
        }
    });
    const auth = subscribeAuthIdentityScope(() => {
        WakeRuleWatch.stop('paused', true);
        resume();
    });
    const visible = () => {
        if (document.visibilityState !== 'hidden') resume();
    };
    document.addEventListener('visibilitychange', visible);
    let appListener: { remove(): Promise<void> } | null = null;
    void import('@capacitor/app')
        .then(async ({ App }) => {
            if (!live) return;
            const listener = await App.addListener('appStateChange', (state) => {
                if (state.isActive) resume();
            });
            if (live) appListener = listener;
            else void listener.remove();
        })
        .catch(() => undefined);
    resume();
    return () => {
        live = false;
        preferences();
        settings();
        auth();
        document.removeEventListener('visibilitychange', visible);
        void appListener?.remove();
        WakeRuleWatch.stop('off', true);
    };
}
