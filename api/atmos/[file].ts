import { proxyReleaseAsset } from '../_releaseAssetProxy';

export const config = { runtime: 'edge' };

export default (request: Request): Promise<Response> => {
    const model = new URL(request.url).searchParams.get('model');
    if (new URL(request.url).searchParams.getAll('model').length !== 1 || (model !== 'gfs' && model !== 'ecmwf')) {
        return Promise.resolve(
            new Response('Choose GFS or ECMWF IFS atmospheric source', {
                status: 400,
                headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
            }),
        );
    }
    return proxyReleaseAsset(request, model === 'gfs' ? 'gfs-atmos' : 'ifs-pressure');
};
