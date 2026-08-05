/** Verified CMEMS SST-grid loader. See cmemsGridTrust for the trust boundary. */
import type { CmemsManifest } from './cmemsGridTrust';
import { fetchCmemsGrid, fetchCmemsManifest, releaseCmemsGrid } from './cmemsGridTrust';

export type SstManifest = CmemsManifest;

export const fetchSstManifest = () => fetchCmemsManifest('sst');
export const fetchSstGrid = (step = 0) => fetchCmemsGrid('sst', step);
export const releaseSstGrid = () => releaseCmemsGrid('sst');
