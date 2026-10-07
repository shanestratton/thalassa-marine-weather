import { useCallback, useState } from 'react';

/**
 * Whether the ENC charts show, and the map-base menu row that flips them
 * (build 123, W1-01 slice 1b).
 *
 * Browse charts start OFF on every fresh Obs (Release 119). Each ENC merge
 * allocates about 25 MB, and on 2026-09-04 the webview hit iOS's hard 2 GB
 * per-process cap with cells merging. That stays the default. Settings →
 * Preferences → Chart → "Show ENC charts when Obs opens" (settings.
 * obsEncOnOpen, off unless set to exactly true) lets a skipper who always
 * wants the charts have them waiting instead.
 *
 * - Only the Obs chart honours the switch. It applies once this map has been
 *   the Obs page (`obsOpen`, MapHub's ownshipStartup), so the location
 *   pickers, the route planner's maps and onboarding never load charts on
 *   its account. After that, a picker or the plotting surface on the same
 *   map does not turn the charts back off: that would throw away merged
 *   cells only to merge them again a moment later.
 * - The menu row wins for the rest of the session, as a base pick does
 *   (useMapBase). Until the skipper uses it, the chart follows the saved
 *   switch, so an account sync that lands after Obs opened is not missed.
 */
export function useEncAtOpen(obsOpen: boolean, showOnOpen: unknown) {
    const [picked, setPicked] = useState<boolean>();
    const [opened, setOpened] = useState(obsOpen);
    // Derived-state latch (React's "store information from previous
    // renders"): set during render, so the first Obs frame already has it.
    if (obsOpen && !opened) setOpened(true);
    const encVisible = picked ?? ((opened || obsOpen) && showOnOpen === true);
    const toggleEnc = useCallback(() => setPicked(!encVisible), [encVisible]);
    return { encVisible, toggleEnc };
}
