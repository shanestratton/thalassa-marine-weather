/**
 * Thalassa Ocean entry (ocean.html → ocean.thalassawx.app). Web only: it
 * shares nothing with the app's boot path, registers no service worker, and
 * loads mapbox-gl lazily (the shared vendor-mapbox chunk) once the page has
 * painted. The data fetches start here, before React or the map, and so does
 * the (non-blocking) web-font stylesheet.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import OceanPage, { bootOcean } from './ocean/OceanPage';
import './ocean/ocean.css';

// Fonts are added from here, not as a <link> in ocean.html: a third-party
// stylesheet in the head blocks rendering, and in Safari it widened the race
// in which the map was built before the page's own CSS had applied.
const FONTS =
    'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,700..900&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap';
const fonts = document.createElement('link');
fonts.rel = 'stylesheet';
fonts.href = FONTS;
document.head.append(fonts);

const boot = bootOcean();
const root = document.getElementById('root');
if (root) {
    createRoot(root).render(
        <StrictMode>
            <OceanPage boot={boot} />
        </StrictMode>,
    );
}
