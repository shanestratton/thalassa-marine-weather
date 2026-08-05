/** Verified CMEMS current-grid loader. See cmemsGridTrust for the trust boundary. */
import type { CmemsManifest } from './cmemsGridTrust';
import { fetchCmemsGrid, fetchCmemsManifest, releaseCmemsGrid } from './cmemsGridTrust';

export type CurrentsManifest = CmemsManifest;

export const fetchCurrentsManifest = () => fetchCmemsManifest('currents');
export const fetchCurrentsGrid = (step = 0) => fetchCmemsGrid('currents', step);
export const releaseCurrentsGrid = () => releaseCmemsGrid('currents');
