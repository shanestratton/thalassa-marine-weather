/** Build-selected unavailable backend/telemetry. Never imports production Auth,
 * SDK, storage or telemetry, and never retains inputs or diagnostics. */
import { FullAppBoundaryUnavailableError } from './boundaries';

let backendAttempts = 0,
    telemetryAttempts = 0;
const count = (lane: 'backend' | 'telemetry') => {
    if (lane === 'backend') backendAttempts = Math.min(1024, backendAttempts + 1);
    else telemetryAttempts = Math.min(1024, telemetryAttempts + 1);
};
const refuse = async (..._args: unknown[]): Promise<never> => {
    count('backend');
    throw new FullAppBoundaryUnavailableError();
};
const absent = async (..._args: unknown[]) => {
    count('backend');
    return null;
};
const refused = async (..._args: unknown[]) => {
    count('backend');
    return false;
};
export const supabase = null;
export const supabaseUrl = '';
export const supabaseAnonKey = '';
export const isSupabaseConfigured = () => false;
export const getCurrentUserId = absent;
export const getCurrentUser = absent;
export const getUserProfile = absent;
export const updateUserProfile = refused;
export const syncWaypoints = refused;
export const migrateAuthSessionToCapacitor = refuse;
export const capacitorAuthStorage = Object.freeze({ getItem: absent, setItem: refuse, removeItem: refuse });

const discardTelemetry = (..._args: unknown[]): void => {
    count('telemetry');
};
export const captureException = discardTelemetry;
export const captureMessage = discardTelemetry;
export const addBreadcrumb = discardTelemetry;
export const setUser = discardTelemetry;
export const setTag = discardTelemetry;
export const buildRelease = () => 'research-not-a-release';
export const ensureSentryLoaded = async (): Promise<never> => {
    count('telemetry');
    throw new FullAppBoundaryUnavailableError();
};
export const readClosedBackendCounters = () => Object.freeze({ backendAttempts, telemetryAttempts });
