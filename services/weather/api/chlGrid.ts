/** Verified CMEMS chlorophyll-grid loader. See cmemsGridTrust for the trust boundary. */
import type { CmemsManifest } from './cmemsGridTrust';
import { fetchCmemsGrid, fetchCmemsManifest, releaseCmemsGrid } from './cmemsGridTrust';

export type ChlManifest = CmemsManifest;

export const fetchChlManifest = () => fetchCmemsManifest('chl');
export const fetchChlGrid = (step = 0) => fetchCmemsGrid('chl', step);
export const releaseChlGrid = () => releaseCmemsGrid('chl');
