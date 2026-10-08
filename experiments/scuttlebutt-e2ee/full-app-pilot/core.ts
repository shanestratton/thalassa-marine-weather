/** App-only native denial. The audited Research bridge uses real core through
 * a different exact build resolution. This is not native plugin availability. */
import { FullAppBoundaryUnavailableError, CapacitorHttp } from './boundaries';
export { CapacitorHttp };
let platform: 'web' | 'ios' = 'web';
let configured = false;
let registrationAttempts = 0,
    methodAttempts = 0;
export function configureFullAppPlatform(value: 'web' | 'ios'): void {
    if (configured && platform !== value) throw new FullAppBoundaryUnavailableError();
    if (value !== 'web' && value !== 'ios') throw new FullAppBoundaryUnavailableError();
    configured = true;
    platform = value;
}
const reject = async (..._args: unknown[]): Promise<never> => {
    methodAttempts = Math.min(1024, methodAttempts + 1);
    throw new FullAppBoundaryUnavailableError();
};
/** Unknown registered native methods refuse, never return success-shaped values.
 * No argument, name, callback or plugin implementation is retained. */
export function registerPlugin<T = Readonly<Record<string, (...args: unknown[]) => Promise<never>>>>(
    _name: string,
    ..._implementations: unknown[]
): T {
    registrationAttempts = Math.min(1024, registrationAttempts + 1);
    return new Proxy(Object.create(null), {
        get(_target, key) {
            if (typeof key !== 'string' || key === 'then' || key === 'toJSON') return undefined;
            return reject;
        },
    }) as T;
}
export const Capacitor = Object.freeze({
    getPlatform: () => platform,
    isNativePlatform: () => platform === 'ios',
    isPluginAvailable: (_name: string) => false,
    convertFileSrc: (_path: string) => '',
});
export class WebPlugin {
    addListener = reject;
    removeAllListeners = reject;
}
export const readFullAppCoreCounters = () => Object.freeze({ registrationAttempts, methodAttempts, platform });
