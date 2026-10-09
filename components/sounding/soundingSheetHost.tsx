/**
 * soundingSheetHost — mounts the Sounding sheet over the whole app (build 125, SND).
 *
 * The Obs tap-a-point bubble lives in its own detached React root inside a
 * Mapbox popup (useWeatherInspectPopup), outside the app's providers, so the
 * sheet it opens gets one too: a node on document.body, above the chart's
 * modal tier and under the night scrim. This module is the lazy chunk's door:
 * the bubble imports it only when the skipper taps "Sounding", so the sheet,
 * its diagram and its maths never ride in the map chunk.
 */
import { createRoot, type Root } from 'react-dom/client';
import { SoundingSheet, type SoundingSheetProps } from './SoundingSheet';

let open: { root: Root; node: HTMLElement } | null = null;

export function closeSoundingSheet(): void {
    if (!open) return;
    const { root, node } = open;
    open = null;
    root.unmount();
    node.remove();
}

/** Open (or replace) the sheet for one point. */
export function openSoundingSheet(props: Omit<SoundingSheetProps, 'onClose'>): void {
    closeSoundingSheet();
    const node = document.createElement('div');
    node.setAttribute('data-sounding-host', '');
    document.body.append(node);
    const root = createRoot(node);
    open = { root, node };
    root.render(<SoundingSheet {...props} onClose={closeSoundingSheet} />);
}
