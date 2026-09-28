import { expect, test } from '@playwright/test';

test('route-free recording HUD and weather timeline fit open and collapsed at 390px', async ({
    page,
    baseURL,
}, info) => {
    test.setTimeout(60_000);
    const origin = new URL(baseURL!).origin;
    const stubs: Record<string, string> = {
        '/hooks/useHudRecording.ts': `export const useHudRecording = () => ({isTracking:true,isPaused:false,isRapidMode:false,currentVoyageId:'layout-only'});`,
        '/hooks/usePassageRecordingMetrics.ts': `export const usePassageRecordingMetrics = () => ({distanceNm:12.4,recordedAt:Date.now()-120000,departedAt:Date.now()-7500000,nowMs:Date.now()});`,
        '/hooks/usePassageHudInstruments.ts': `export const usePassageHudInstruments = () => ({sog:{value:6.1,freshness:'live'},cog:{value:44,freshness:'live'},tws:{value:14,freshness:'stale'},twd:{value:350,freshness:'live'},aws:{value:18,freshness:'live'},awa:{value:-33,freshness:'live'},via:'lan',connectionStatus:'remote'});`,
        '/services/GpsReceiverStatusService.ts': `const state={active:true,kind:'vessel-nmea',label:'On-board GPS',detail:'Live via the Pi · GPS · 11 sats · HDOP 0.9',isNmea:true,satellites:11,hdop:0.9,avgAccuracy:null,qualityLabel:null,deviceName:'layout-only'}; export const GpsReceiverStatusService={getStatus:()=>state,refresh:async()=>state};`,
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
        const stub = stubs[url.pathname];
        return stub ? route.fulfill({ contentType: 'text/javascript', body: stub }) : route.continue();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/fixtures/passage-recording.html');
    const pane = page.getByTestId('passage-hud');
    const timeline = page.getByRole('slider', { name: 'Wind timeline' });
    await expect(pane).toHaveAttribute('data-mode', 'live');
    await expect(page.getByTestId('hud-recorded-distance')).toContainText('Sailed12NM');
    await expect(page.getByTestId('hud-recording-elapsed')).toContainText('2h 5m');
    await expect(page.getByTestId('hud-tws')).toContainText('OLD');
    await expect(timeline).toBeInViewport();
    await expect(page.getByTestId('hud-look-ahead')).toHaveCount(0);
    await expect(page.getByTestId('route-time-scrubber')).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    const problems = await page.evaluate(() => {
        const issues: string[] = [];
        const pane = document.querySelector<HTMLElement>('[data-testid="passage-hud"]')!;
        const box = pane.getBoundingClientRect();
        if (box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight)
            issues.push('HUD outside viewport');
        for (const element of [document.documentElement, document.body, pane]) {
            if (element.scrollWidth > element.clientWidth + 1) issues.push('Horizontal overflow');
        }
        for (const selector of [
            '[data-testid="hud-sog"]',
            '[data-testid="hud-awa"]',
            '[aria-label="Hide passage instruments"]',
            '[aria-label="Wind timeline"]',
            '[aria-label="Hide weather controls"]',
        ]) {
            const element = document.querySelector<HTMLElement>(selector)!;
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            if (
                rect.left < 0 ||
                rect.right > innerWidth ||
                rect.top < 0 ||
                rect.bottom > innerHeight ||
                !hit ||
                (hit !== element && !element.contains(hit))
            )
                issues.push(`Clipped or overlapped: ${selector}`);
        }
        const slider = document.querySelector('[aria-label="Wind timeline"]')!.getBoundingClientRect();
        if (slider.top < box.bottom && slider.right > box.left && slider.left < box.right)
            issues.push('HUD overlaps weather timeline');
        return issues;
    });
    expect(problems).toEqual([]);
    await page.screenshot({ path: info.outputPath('recording-hud-open.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Hide passage instruments' }).click();
    await expect(pane).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Show passage instruments' })).toBeInViewport();
    await expect(timeline).toBeInViewport();
    await timeline.focus();
    await timeline.press('ArrowRight');
    await expect(timeline).toHaveAttribute('aria-valuenow', '1');
    // The wind timeline names the frame's valid time from the model run
    // (06:00 UTC in the fixture), not just its offset.
    await expect(timeline).toHaveAttribute('aria-valuetext', '+1h — Forecast · Valid 09-27 07:00 UTC');
    await page.screenshot({
        path: info.outputPath('recording-hud-collapsed-weather-preview.png'),
        animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Show passage instruments' }).click();
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute('data-mode', 'live');
    await expect(timeline).toHaveAttribute('aria-valuenow', '1');
    await expect(page.getByTestId('hud-sog')).toContainText('6.1');
    expect(errors).toEqual([]);
});
