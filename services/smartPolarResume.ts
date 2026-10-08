/**
 * smartPolarResume — Smart Polars keep learning after a restart (build 125,
 * package 125-08; gap register #12a, learned-polars).
 *
 * The switch in Settings → Preferences (components/settings/SmartPolarsSetting)
 * starts the learner, and until now nothing started it again: every launch
 * quietly stopped the learning until the skipper toggled it off and on.
 *
 * At launch (hooks/useAppBootstrap) this reads the switch once this device's
 * settings have loaded — not the defaults painted first — and, when it is on,
 * starts the learner. It starts ONLY the learner: which link the instruments
 * come through (the Pi, or a gateway socket, and never a socket ashore) stays
 * InstrumentSourcePolicy's call at boot. The learner records whatever samples
 * that feed brings. Off, it loads nothing at all.
 */
import { awaitSettingsLoaded, useSettingsStore } from '../stores/settingsStore';

/** True when the learner was resumed. */
export async function resumeSmartPolarsAtLaunch(): Promise<boolean> {
    await awaitSettingsLoaded();
    if (useSettingsStore.getState().settings.smartPolarsEnabled !== true) return false;
    const { SmartPolarService } = await import('./SmartPolarService');
    await SmartPolarService.start();
    return true;
}
