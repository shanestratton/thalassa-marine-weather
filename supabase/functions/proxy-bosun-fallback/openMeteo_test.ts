import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { createOpenMeteoClient, OPEN_METEO_UPSTREAMS } from './openMeteo.ts';

/**
 * 127-H: Calypso's cloud weather tool on Open-Meteo's commercial customer
 * endpoints. The key rides only in the upstream query string, so no URL may
 * reach a log line, an error message or the model's context, and no key means
 * no lookup — never the free (non-commercial) hosts. Coordinates are fictional.
 */
const KEY = 'fictional-open-meteo-key';

type Call = { url: URL; timeoutMs: number };

function recorder(answer: (url: URL) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetcher = async (input: string, _init: RequestInit, timeoutMs: number) => {
        const url = new URL(input);
        calls.push({ url, timeoutMs });
        return await answer(url);
    };
    return { calls, fetcher };
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.test('the three upstreams are the customer hosts', () => {
    assertEquals(OPEN_METEO_UPSTREAMS, {
        geocode: 'https://customer-geocoding-api.open-meteo.com/v1/search',
        forecast: 'https://customer-api.open-meteo.com/v1/forecast',
        marine: 'https://customer-marine-api.open-meteo.com/v1/marine',
    });
});

Deno.test('no key: nothing is fetched, and the tool gets its usual failures', async () => {
    for (const missing of [undefined, '']) {
        const { calls, fetcher } = recorder(() => json({}));
        const client = createOpenMeteoClient(missing, fetcher);
        assertEquals(await client.geocode('Whitehaven Beach'), null);
        assertEquals(await client.marine(-20.28, 149.04), null);
        const error = await assertRejects(() => client.forecast(-20.28, 149.04));
        assertEquals((error as Error).message, 'Open-Meteo is not configured');
        assertEquals(calls.length, 0);
    }
});

Deno.test('geocode asks the customer geocoder with the key and returns the first hit', async () => {
    const { calls, fetcher } = recorder(() =>
        json({
            results: [
                { name: 'Porto Ficticio', latitude: 38.5312, longitude: -28.6271, country: 'Exampleland' },
            ],
        })
    );
    const hit = await createOpenMeteoClient(KEY, fetcher).geocode('Porto Ficticio');

    assertEquals(hit, {
        name: 'Porto Ficticio',
        latitude: 38.5312,
        longitude: -28.6271,
        country: 'Exampleland',
        admin1: undefined,
    });
    assertEquals(calls.length, 1);
    const { url } = calls[0];
    assertEquals(`${url.origin}${url.pathname}`, OPEN_METEO_UPSTREAMS.geocode);
    assertEquals(Object.fromEntries(url.searchParams), {
        name: 'Porto Ficticio',
        count: '1',
        language: 'en',
        format: 'json',
        apikey: KEY,
    });
});

Deno.test('geocode returns null for no match, a malformed hit, an error status or a dead network', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
        () => json({ generationtime_ms: 0.4 }),
        () => json({ results: [{ name: 'Nowhere', latitude: 'north', longitude: null }] }),
        () => json({ error: true, reason: 'quota' }, 429),
        () => {
            throw new TypeError(`error sending request for url (${OPEN_METEO_UPSTREAMS.geocode}?apikey=${KEY})`);
        },
    ];
    for (const answer of answers) {
        const { fetcher } = recorder(answer);
        assertEquals(await createOpenMeteoClient(KEY, fetcher).geocode('Whitehaven Beach'), null);
    }
});

Deno.test('forecast and marine ask the customer hosts with the key, in knots and local time', async () => {
    const { calls, fetcher } = recorder((url) => json({ host: url.hostname }));
    const client = createOpenMeteoClient(KEY, fetcher);

    assertEquals(await client.forecast(51.9012, -8.4011), { host: 'customer-api.open-meteo.com' });
    assertEquals(await client.marine(51.9012, -8.4011), { host: 'customer-marine-api.open-meteo.com' });

    const [forecast, marine] = calls.map((call) => call.url);
    assertEquals(`${forecast.origin}${forecast.pathname}`, OPEN_METEO_UPSTREAMS.forecast);
    assertEquals(forecast.searchParams.get('latitude'), '51.9012');
    assertEquals(forecast.searchParams.get('longitude'), '-8.4011');
    assertEquals(forecast.searchParams.get('wind_speed_unit'), 'kn');
    assertEquals(forecast.searchParams.get('forecast_days'), '2');
    assertEquals(forecast.searchParams.get('timezone'), 'auto');
    assertEquals(forecast.searchParams.get('apikey'), KEY);
    assert(forecast.searchParams.get('current')?.includes('wind_gusts_10m'));
    assertEquals(`${marine.origin}${marine.pathname}`, OPEN_METEO_UPSTREAMS.marine);
    assertEquals(marine.searchParams.get('apikey'), KEY);
    assert(marine.searchParams.get('current')?.includes('swell_wave_height'));
});

Deno.test('no failure ever carries the URL, so the key cannot leak into a message', async () => {
    // Deno's own network errors name the full URL, query string and all.
    const leaky = () => {
        throw new TypeError(
            `error sending request for url (${OPEN_METEO_UPSTREAMS.forecast}?latitude=1&apikey=${KEY}): connection reset`,
        );
    };
    for (
        const answer of [
            leaky,
            () => json({ error: true }, 500),
            () => new Response('not json', { status: 200 }),
        ]
    ) {
        const { fetcher } = recorder(answer);
        const client = createOpenMeteoClient(KEY, fetcher);
        const error = await assertRejects(() => client.forecast(1, 2));
        const message = (error as Error).message;
        assert(!message.includes(KEY), message);
        assert(!message.includes('open-meteo.com'), message);
        assert(/^Open-Meteo /.test(message), message);
        assertEquals(await client.marine(1, 2), null);
    }
});
