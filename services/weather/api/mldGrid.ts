/** Verified CMEMS mixed-layer-depth loader. See cmemsGridTrust for the trust boundary. */
import type { CmemsManifest } from './cmemsGridTrust';
import { fetchCmemsGrid, fetchCmemsManifest, releaseCmemsGrid } from './cmemsGridTrust';

export type MldManifest = CmemsManifest;

export const fetchMldManifest = () => fetchCmemsManifest('mld');
export const fetchMldGrid = (step = 0) => fetchCmemsGrid('mld', step);
export const releaseMldGrid = () => releaseCmemsGrid('mld');
