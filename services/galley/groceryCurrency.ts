/**
 * The currency a new grocery row is stamped with (132-B17, binder audit
 * GAL-09): the one chosen in Settings → Preferences, which rides the account's
 * settings to every phone, or with none chosen, this phone's region's
 * (utils/money resolveCurrency). It used to be 'AUD' for everyone.
 *
 * Rows already on the list keep the currency they were saved in: a price is
 * never relabelled.
 */
import { useSettingsStore } from '../../stores/settingsStore';
import { resolveCurrency } from '../../utils/money';
import { createLogger, getErrorMessage } from '../../utils/createLogger';

const log = createLogger('Galley');

/** The currency new grocery rows and their prices go in. */
export function groceryCurrency(): string {
    let chosen: string | null | undefined;
    try {
        chosen = useSettingsStore.getState().settings.currency;
    } catch (error) {
        // Settings not readable yet: the phone's region still answers.
        log.warn('galley: currency-setting', getErrorMessage(error));
    }
    return resolveCurrency(chosen);
}

/** The same, for a screen: follows a change made in Preferences or synced from another phone. */
export function useGroceryCurrency(): string {
    return resolveCurrency(useSettingsStore((state) => state.settings.currency));
}
