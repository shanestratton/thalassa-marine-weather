/**
 * The ONLY way into the debug AIS injector (build 125, 125-01 item 11).
 *
 * __THALASSA_DEBUG_AIS_INJECTOR__ is a build-time constant (vite.config.ts):
 * true only when the build runs with THALASSA_DEBUG_AIS_INJECTOR=1, for the
 * 125-11 locked-phone + Focus device smoke. In every other build it is the
 * literal false, so Rollup folds this conditional and never emits the panel's
 * or the injector's chunk; the production build also fails if the injector's
 * marker reaches any chunk (scripts/debug-ais-injector-fence.mjs).
 * tests/DebugAisInjectorRelease.test.ts proves both with a real Vite build.
 */
import { lazy } from 'react';

export const DebugAisInjectorSection = __THALASSA_DEBUG_AIS_INJECTOR__
    ? lazy(() => import('./DebugAisInjectorSection').then((m) => ({ default: m.DebugAisInjectorSection })))
    : null;
