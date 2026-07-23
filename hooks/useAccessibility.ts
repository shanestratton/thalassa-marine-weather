export { useFocusTrap } from './useFocusTrap';

/**
 * Hook to detect user's prefers-reduced-motion setting.
 * Returns true if the user prefers reduced motion.
 */
export function useReducedMotion(): boolean {
    const query = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    // Use a simple check — no need for state since this rarely changes mid-session
    return query?.matches ?? false;
}
