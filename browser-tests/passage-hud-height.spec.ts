import { expect, test } from '@playwright/test';

test('all HUD readings fit without inner scrolling while timelines and navigation stay clear', async ({
    page,
    baseURL,
}, info) => {
    test.setTimeout(60_000);
    const origin = new URL(baseURL!).origin;
    const stubs: Record<string, string> = {
        '/hooks/useHudRecording.ts': `export const useHudRecording=()=>({isTracking:true,isPaused:false,isRapidMode:false,currentVoyageId:'layout-only'});`,
        '/hooks/usePassageRecordingMetrics.ts': `export const usePassageRecordingMetrics=()=>({distanceNm:12.4,recordedAt:Date.now()-120000,departedAt:Date.now()-7500000,nowMs:Date.now()});`,
        '/hooks/usePassageHudInstruments.ts': `export const usePassageHudInstruments=()=>({sog:{value:6.1,freshness:'live'},cog:{value:44,freshness:'live'},tws:{value:14,freshness:'stale'},twd:{value:350,freshness:'live'},aws:{value:18,freshness:'live'},awa:{value:-33,freshness:'live'},via:'lan',connectionStatus:'remote'});`,
        '/hooks/usePassageEta.ts': `export const usePassageEta=()=>({arrivalMs:Date.now()+3*3600000,speedKts:6,basis:'average',sampleMinutes:20});`,
        '/services/GpsService.ts': `const p={latitude:-27.5,longitude:153,timestamp:Date.now()};export const GpsService={getLastKnownPosition:()=>p,watchPosition:()=>()=>{}};`,
        '/services/GpsReceiverStatusService.ts': `const state={active:true,kind:'vessel-nmea',label:'On-board GPS',detail:'Live via the Pi · GPS · 11 sats · HDOP 0.9',isNmea:true,satellites:11,hdop:0.9,avgAccuracy:null,qualityLabel:null,deviceName:'layout-only'};export const GpsReceiverStatusService={getStatus:()=>state,refresh:async()=>state};`,
        '/stores/settingsStore.ts': `const state={settings:{vessel:{cruisingSpeed:6,length:42,type:'sail'},units:{waveHeight:'m'}}};export const useSettingsStore=Object.assign(s=>s(state),{getState:()=>state,subscribe:()=>()=>{}});`,
        '/services/weather/openMeteoProxy.ts': `export const fetchOpenMeteoPoints=async(op,points,params)=>{
            const time=Array.from({length:170},(_,h)=>Math.floor(Date.now()/3600000)*3600+h*3600);
            const col=value=>time.map(()=>value);
            if(op==='marine')return points.map(p=>({latitude:p.lat,longitude:p.lon,hourly_units:{wave_height_meteofrance_wave:'m',wave_period_meteofrance_wave:'s',ocean_current_velocity_marine_best_match:'km/h',ocean_current_direction_marine_best_match:'°'},hourly:{time,wave_height_meteofrance_wave:col(1.4),wave_period_meteofrance_wave:col(7),wave_direction_meteofrance_wave:col(120),ocean_current_velocity_marine_best_match:col(1.852),ocean_current_direction_marine_best_match:col(0)}}));
            const models=String(params.models).split(',');return points.map(()=>{const hourly={time};models.forEach((m,i)=>{const s=models.length>1?'_'+m:'';Object.assign(hourly,{['wind_speed_10m'+s]:col(10+i*5),['wind_direction_10m'+s]:col(120+i*20),['wind_gusts_10m'+s]:col(24+i*5),['precipitation'+s]:col(1.2),['precipitation_probability'+s]:col(60)});});return {hourly};});};`,
    };
    await page.route('**/*', (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (
            url.origin !== origin ||
            !['GET', 'HEAD'].includes(request.method()) ||
            /^\/(api|functions)\//.test(url.pathname)
        )
            return route.abort();
        return stubs[url.pathname]
            ? route.fulfill({ contentType: 'text/javascript', body: stubs[url.pathname] })
            : route.continue();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    for (const mode of ['recording', 'route', 'forecast']) {
        await page.setViewportSize({ width: 393, height: 852 });
        await page.goto(`/e2e/fixtures/passage-recording.html?mode=${mode}`);
        const pane = page.getByTestId('passage-hud');
        await expect(pane).toBeVisible();
        await page.evaluate(() => {
            const credit = document.createElement('div');
            credit.style.cssText = 'position:absolute;top:60px;left:80px;width:200px;height:48px;';
            credit.innerHTML = '<a aria-label="Rain radar data by RainViewer">Radar by RainViewer</a>';
            document.querySelector('main')!.append(credit);
        });
        if (mode === 'forecast') await expect(page.getByTestId('hud-models-split')).toBeVisible();
        await expect(pane).toHaveCSS('top', '116px');
        await expect
            .poll(async () =>
                pane.evaluate((el) => {
                    const cells = el.querySelector('.thalassa-passage-hud-cells')!;
                    return cells.scrollHeight - cells.clientHeight;
                }),
            )
            .toBeLessThanOrEqual(1);
        const expected =
            mode === 'forecast'
                ? [
                      'hud-route',
                      'hud-eta',
                      'hud-tws',
                      'hud-gust',
                      'hud-twd',
                      'hud-sea',
                      'hud-set',
                      'hud-rain',
                      'hud-aws',
                  ]
                : [
                      mode === 'route' ? 'hud-route' : 'hud-recorded-distance',
                      mode === 'route' ? 'hud-eta' : 'hud-recording-elapsed',
                      'hud-sog',
                      'hud-cog',
                      'hud-tws',
                      'hud-twd',
                      'hud-aws',
                      'hud-awa',
                  ];
        for (const id of expected) await expect(page.getByTestId(id)).toBeInViewport();
        expect(
            await pane.evaluate((el) => {
                const bounds = el.getBoundingClientRect();
                const timeline =
                    document.querySelector('.thalassa-route-scrubber') ??
                    document.querySelector('[role="slider"][aria-label$=" timeline"]')!.closest('.absolute');
                // The fixture's stand-in bar (e2e/fixtures/passage-recording.tsx),
                // not App.tsx: it is still labelled for PassageHudPane's own
                // lookup, and the three must change together.
                const navigation = document.querySelector('nav[aria-label="Main"]')!;
                return (
                    bounds.bottom <= timeline!.getBoundingClientRect().top - 7 &&
                    bounds.bottom < navigation.getBoundingClientRect().top
                );
            }),
        ).toBe(true);
        await page.screenshot({ path: info.outputPath(`hud-${mode}-full-height.png`), animations: 'disabled' });
    }
});
