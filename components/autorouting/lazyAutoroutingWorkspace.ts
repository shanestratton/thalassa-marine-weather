import { lazyRetry } from '../../utils/lazyRetry';

/**
 * Auto's chart, loaded on first use. One loader for both doors (Auto's own
 * dialog and Plan Your Day's routed stop, 127-PYD-3), so the chunk's preload
 * list is built once, not once per door.
 */
export const LazyAutoroutingWorkspace = lazyRetry(
    () => import('./AutoroutingTrialWorkspace').then((module) => ({ default: module.AutoroutingTrialWorkspace })),
    'AutoroutingTrialWorkspace',
);
