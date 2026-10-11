/**
 * OpenSeaMap's credit, one constant for every map that draws its seamark
 * tiles (127-DESKMAP B3). The tiles are CC BY-SA 2.0 and the data under them
 * ODbL; commercial use is allowed with this credit (openseamap.org FAQ). Until
 * 127 none of the seven sites named either licence, and the desk turns the
 * seamarks on by default for everyone.
 *
 * Dependency-free on purpose: logMap and the chat pin viewer import it and
 * nothing else comes with it.
 */
export const OPENSEAMAP_URL = 'https://www.openseamap.org';
export const OPENSEAMAP_ATTRIBUTION =
    `Seamarks &copy; <a href="${OPENSEAMAP_URL}" target="_blank" rel="noopener noreferrer">OpenSeaMap</a> contributors, ` +
    '<a href="https://creativecommons.org/licenses/by-sa/2.0/" target="_blank" rel="noopener noreferrer license">CC BY-SA 2.0</a>; ' +
    'data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors, ODbL';
/** The same credit as plain text, for an aria-label. */
export const OPENSEAMAP_CREDIT_TEXT = OPENSEAMAP_ATTRIBUTION.replace(/<[^>]+>/g, '').replace(/&copy;/g, '©');
