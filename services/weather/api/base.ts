import { CapacitorHttp } from '@capacitor/core';

const BASE_URL = 'https://api.stormglass.io/v2';

export const fetchSG = async <T>(endpoint: string, params: Record<string, any>, apiKey: string): Promise<T> => {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const url = new URL(`${BASE_URL}/${cleanEndpoint}`);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    try {
        // Use Native HTTP to bypass CORS/SSL issues on simulator/device
        const options = {
            url: url.toString(),
            headers: { 'Authorization': apiKey }
        };
        const res = await CapacitorHttp.get(options);

        // CapacitorHttp returns 'data' as parsed JSON object directly for JSON responses
        // and 'status' as number.
        if (!res) {
            throw new Error('SG_NO_RESPONSE: CapacitorHttp returned null/undefined');
        }

        if (res.status !== 200) {
            if (res.status === 402 || res.status === 429) {
                throw new Error(`SG_QUOTA: ${res.status} - ${JSON.stringify(res.data)}`);
            }
            throw new Error(`SG_HTTP_${res.status}: ${JSON.stringify(res.data)}`);
        }

        if (!res.data) {
            throw new Error('SG_NO_DATA: Response status 200 but no data');
        }

        return res.data as T;
    } catch (e: any) {

        try {
            const res = await fetch(url.toString(), {
                headers: { 'Authorization': apiKey }
            });

            if (!res.ok) {
                const body = await res.text();
                throw new Error(`SG_HTTP_FETCH_${res.status}: ${body}`);
            }
            return await res.json() as T;
        } catch (fetchErr: any) {
            throw fetchErr;
        }
    }
};
