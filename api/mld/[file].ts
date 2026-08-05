import { proxyReleaseAsset } from '../_releaseAssetProxy';

export const config = { runtime: 'edge' };

export default (request: Request): Promise<Response> => proxyReleaseAsset(request, 'mld');
