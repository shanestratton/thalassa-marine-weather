/** Verified CMEMS wave-grid loader. See cmemsGridTrust for the trust boundary. */
import type { CmemsManifest } from './cmemsGridTrust';
import { fetchCmemsGrid, fetchCmemsManifest, releaseCmemsGrid } from './cmemsGridTrust';

export type WavesManifest = CmemsManifest;

export const fetchWavesManifest = () => fetchCmemsManifest('waves');
export const fetchWavesGrid = (step = 0) => fetchCmemsGrid('waves', step);
export const releaseWavesGrid = () => releaseCmemsGrid('waves');
