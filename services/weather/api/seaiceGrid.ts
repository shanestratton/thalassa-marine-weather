/** Verified CMEMS sea-ice-grid loader. See cmemsGridTrust for the trust boundary. */
import type { CmemsManifest } from './cmemsGridTrust';
import { fetchCmemsGrid, fetchCmemsManifest, releaseCmemsGrid } from './cmemsGridTrust';

export type SeaIceManifest = CmemsManifest;

export const fetchSeaIceManifest = () => fetchCmemsManifest('seaice');
export const fetchSeaIceGrid = (step = 0) => fetchCmemsGrid('seaice', step);
export const releaseSeaIceGrid = () => releaseCmemsGrid('seaice');
