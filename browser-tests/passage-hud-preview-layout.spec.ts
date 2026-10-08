import { expect, test, type Page } from '@playwright/test';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * The passage HUD is standard (build 124, package HS). A route pulled up on Obs
 * is previewed on the HUD, labelled "Preview — not following", with a departure
 * control; and the open strip starts below the Sat cloud and lightning credits
 * instead of lying over them (the one 123 gap: the strip made room only for the
 * Copernicus and rain credits).
 *
 * The real PassageHudPane, MapWeatherControls, SatelliteIrCredit and
 * BlitzortungAttribution with the real CSS (e2e/fixtures/passage-recording.tsx
 * ?mode=preview&credits=1), the credits at MapHub's own slots, the stand-in top
 * row and the tab bar at their real heights. House rules measured, not assumed,
 * at 320 × 568 and 375 × 667 in wide fonts (Verdana on a Mac, DejaVu Sans on the
 * Linux runner): the strip never covers a credit, the tab bar or the weather
 * controls; its label and its controls are whole and hit-testable; nothing runs
 * off sideways. The readings may scroll inside the strip at these heights — the
 * strip's documented last resort — but never its label or its buttons.
 */

const sizes = [
    { name: '320x568', width: 320, height: 568 },
    { name: '375x667', width: 375, height: 667 },
];

async function fixture(page: Page, baseURL: string) {
    const origin = new URL(baseURL).origin;
    const stubs: Record<string, string> = {
        // Nothing recording: the preview and the followed route stand on their own.
        '/hooks/useHudRecording.ts': `export const useHudRecording=()=>({isTracking:false,isPaused:false,isRapidMode:false});export const useHudRecordingActivation=()=>{};`,
        '/hooks/usePassageRecordingMetrics.ts': `export const usePassageRecordingMetrics=()=>({distanceNm:null,recordedAt:null,departedAt:null,nowMs:Date.now()});`,
        '/hooks/usePassageHudInstruments.ts': `export const usePassageHudInstruments=()=>({sog:{value:5.4,freshness:'live'},cog:{value:192,freshness:'live'},tws:{value:16,freshness:'live'},twd:{value:250,freshness:'live'},aws:{value:19,freshness:'live'},awa:{value:-52,freshness:'live'},via:'lan',connectionStatus:'remote'});`,
        '/hooks/usePassageEta.ts': `export const usePassageEta=()=>({arrivalMs:Date.now()+9*3600000,speedKts:6,basis:'average',sampleMinutes:20});`,
        '/services/GpsService.ts': `const p={latitude:-27.45,longitude:153.0,timestamp:Date.now()};export const GpsService={getLastKnownPosition:()=>p,watchPosition:()=>()=>{}};`,
        '/services/GpsReceiverStatusService.ts': `const state={active:true,kind:'vessel-nmea',label:'On-board GPS',detail:'Live via the Pi · GPS · 9 sats · HDOP 1.0',isNmea:true,satellites:9,hdop:1,avgAccuracy:null,qualityLabel:null,deviceName:'layout-only'};export const GpsReceiverStatusService={getStatus:()=>state,refresh:async()=>state};`,
        '/services/weather/api/blitzortungLightning.ts': `export const subscribeLightningStatus=(cb)=>{cb({status:'stalled',retryAttempts:2,viewportCount:0,viewportRate:0});return()=>{};};`,
        '/stores/settingsStore.ts': `const state={settings:{vessel:{cruisingSpeed:6,length:40,type:'sail'},units:{waveHeight:'m'}}};export const useSettingsStore=Object.assign(s=>s(state),{getState:()=>state,subscribe:()=>()=>{}});`,
        // Every export, so nothing else in the graph fails to link: only the route samplers are answered.
        '/services/weather/openMeteoProxy.ts': `export const fetchOpenMeteoProxy=async()=>{throw new Error('layout fixture: no network');};export const fetchOpenMeteoPoints=async(op,points,params)=>{
            const time=Array.from({length:170},(_,h)=>Math.floor(Date.now()/3600000)*3600+h*3600);
            const col=value=>time.map(()=>value);
            if(op==='marine')return points.map(p=>({latitude:p.lat,longitude:p.lon,hourly_units:{wave_height_meteofrance_wave:'m',wave_period_meteofrance_wave:'s',ocean_current_velocity_marine_best_match:'km/h',ocean_current_direction_marine_best_match:'°'},hourly:{time,wave_height_meteofrance_wave:col(1.1),wave_period_meteofrance_wave:col(6),wave_direction_meteofrance_wave:col(250),ocean_current_velocity_marine_best_match:col(0.9),ocean_current_direction_marine_best_match:col(90)}}));
            const models=String(params.models).split(',');return points.map(()=>{const hourly={time};models.forEach((m,i)=>{const s=models.length>1?'_'+m:'';Object.assign(hourly,{['wind_speed_10m'+s]:col(12+i*3),['wind_direction_10m'+s]:col(240+i*10),['wind_gusts_10m'+s]:col(20+i*3),['precipitation'+s]:col(0.2),['precipitation_probability'+s]:col(20)});});return {hourly};});};`,
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
    await applyWideFonts(page);
}

/** Every geometric rule for the open strip, measured in the page. Returns what broke. */
function stripIssues(page: Page, controls: string[]) {
    return page.evaluate((selectors) => {
        const issues: string[] = [];
        const W = window.innerWidth;
        const H = window.innerHeight;
        const pane = document.querySelector<HTMLElement>('[data-testid="passage-hud"]')!;
        const box = pane.getBoundingClientRect();
        const overlaps = (a: DOMRect, b: DOMRect) =>
            a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        if (box.left < 0 || box.right > W || box.top < 0 || box.bottom > H) issues.push('strip outside the screen');
        for (const [name, selector] of [
            ['Sat cloud credit', '[data-testid="sat-ir-credit"]'],
            ['lightning credit', '[data-testid="lightning-credit"]'],
        ]) {
            const credit = document.querySelector(selector);
            if (!credit) {
                issues.push(`no ${name} on the chart`);
                continue;
            }
            const rect = credit.getBoundingClientRect();
            if (overlaps(box, rect)) issues.push(`strip covers the ${name} (${rect.bottom} > ${box.top})`);
            // Sharing the column is the point of the test: the strip must have moved.
            if (!(rect.left < box.right && rect.right > box.left)) issues.push(`${name} is not in the strip's column`);
        }
        const nav = document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect();
        if (box.bottom > nav.top) issues.push('strip runs under the tab bar');
        for (const selector of [
            '[aria-label="Hide weather controls"]',
            '[aria-label="Show weather controls"]',
            '.thalassa-route-scrubber',
        ]) {
            const element = document.querySelector(selector);
            if (element && overlaps(box, element.getBoundingClientRect())) issues.push(`strip covers ${selector}`);
        }
        for (const element of [document.documentElement, document.body, pane]) {
            if (element.scrollWidth > element.clientWidth + 1) issues.push(`sideways overflow in ${element.tagName}`);
        }
        for (const selector of selectors) {
            const element = document.querySelector<HTMLElement>(selector);
            if (!element) {
                issues.push(`missing ${selector}`);
                continue;
            }
            const rect = element.getBoundingClientRect();
            if (
                rect.top < box.top - 0.5 ||
                rect.bottom > box.bottom + 0.5 ||
                rect.left < box.left - 0.5 ||
                rect.right > box.right + 0.5
            )
                issues.push(`${selector} is cut off by the strip`);
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            if (!hit || (hit !== element && !element.contains(hit))) issues.push(`${selector} is covered`);
            if (element.scrollWidth > element.clientWidth + 1) issues.push(`${selector} overflows sideways`);
        }
        return issues;
    }, controls);
}

for (const size of sizes) {
    test(`the preview HUD is labelled, offers a departure and clears the credits at ${size.name}, wide fonts`, async ({
        page,
        baseURL,
    }, info) => {
        test.setTimeout(60_000);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await fixture(page, baseURL!);
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto('/e2e/fixtures/passage-recording.html?mode=preview&credits=1');
        const pane = page.getByTestId('passage-hud');
        await expect(pane).toBeVisible();
        await expect(pane).toHaveAttribute('data-subject', 'preview');
        await page.evaluate(() => document.fonts.ready);
        await expectWideFaceDrawn(page.getByTestId('hud-preview'));
        await expect(page.getByTestId('hud-preview')).toHaveText('Preview — not following');
        const departure = page.getByRole('button', { name: 'Choose a departure to preview Cowes → Cherbourg' });
        await expect(departure).toBeVisible();
        const live = [
            '[data-testid="hud-preview"]',
            '[data-testid="hud-look-ahead"]',
            '[aria-label="Hide passage instruments"]',
        ];
        await expect.poll(() => stripIssues(page, live)).toEqual([]);
        await page.screenshot({ path: info.outputPath(`preview-live-${size.name}.png`), animations: 'disabled' });
        // The weather controls tuck themselves away after six idle seconds; then
        // the route's own cell is whole without scrolling, even at 320 x 568
        // under both credits.
        await page.getByRole('button', { name: 'Hide weather controls' }).click();
        await expect(page.getByRole('button', { name: 'Show weather controls' })).toBeVisible();
        await expect.poll(() => stripIssues(page, [...live, '[data-testid="hud-route"]'])).toEqual([]);
        await page.screenshot({
            path: info.outputPath(`preview-live-tucked-${size.name}.png`),
            animations: 'disabled',
        });

        // The existing departure dialog, then the forecast from the route's first point.
        await departure.click();
        const dialog = page.getByRole('dialog', { name: 'When will you leave?' });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: /Preview passage/ }).click();
        await expect(pane).toHaveAttribute('data-mode', 'forecast');
        await expect(page.locator('.thalassa-route-scrubber')).toBeVisible();
        await expect(page.getByTestId('hud-preview')).toHaveText('Preview — not following');
        await expect.poll(() => stripIssues(page, live)).toEqual([]);
        await page.screenshot({ path: info.outputPath(`preview-forecast-${size.name}.png`), animations: 'disabled' });

        // Readings tucked away: the ghost and the scrubber stay, and the tab
        // beside them still says Preview, whole, in wide fonts.
        await page.getByRole('button', { name: 'Hide passage instruments' }).click();
        const tab = page.getByRole('button', { name: 'Show route preview, not following' });
        await expect(tab).toBeVisible();
        await expect(tab).toHaveText('Preview');
        await expect(page.locator('.thalassa-route-scrubber')).toBeVisible();
        await expect
            .poll(() =>
                tab.evaluate((element) => {
                    const issues: string[] = [];
                    const box = element.getBoundingClientRect();
                    const word = element.querySelector('span')!.getBoundingClientRect();
                    if (
                        word.top < box.top - 0.5 ||
                        word.bottom > box.bottom + 0.5 ||
                        word.left < box.left - 0.5 ||
                        word.right > box.right + 0.5
                    )
                        issues.push(
                            `the word runs out of the tab (${word.top}-${word.bottom} in ${box.top}-${box.bottom})`,
                        );
                    if (element.scrollHeight > element.clientHeight + 1) issues.push('the tab overflows');
                    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                    if (!hit || (hit !== element && !element.contains(hit))) issues.push('the tab is covered');
                    // The scrubber's own controls stay whole and hit-testable beside the tab.
                    for (const selector of ['[data-testid="route-scrub-play"]', '[data-testid="route-scrub-exit"]']) {
                        const control = document.querySelector(selector)!;
                        const rect = control.getBoundingClientRect();
                        const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                        if (!at || (at !== control && !control.contains(at))) issues.push(`${selector} is covered`);
                    }
                    return issues;
                }),
            )
            .toEqual([]);
        await page.screenshot({ path: info.outputPath(`preview-tucked-${size.name}.png`), animations: 'disabled' });
        expect(errors).toEqual([]);
    });

    test(`a followed route's open strip clears the Sat cloud and lightning credits at ${size.name}, wide fonts`, async ({
        page,
        baseURL,
    }, info) => {
        test.setTimeout(60_000);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await fixture(page, baseURL!);
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto('/e2e/fixtures/passage-recording.html?mode=route&credits=1');
        const pane = page.getByTestId('passage-hud');
        await expect(pane).toBeVisible();
        await expect(pane).toHaveAttribute('data-subject', 'route');
        await page.evaluate(() => document.fonts.ready);
        await expectWideFaceDrawn(page.getByTestId('hud-mode'));
        await expect
            .poll(() => stripIssues(page, ['[data-testid="hud-mode"]', '[aria-label="Hide passage instruments"]']))
            .toEqual([]);
        await page.screenshot({ path: info.outputPath(`route-live-${size.name}.png`), animations: 'disabled' });
        expect(errors).toEqual([]);
    });
}
