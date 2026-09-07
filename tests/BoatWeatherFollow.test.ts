/**
 * The weather is for the BOAT.
 *
 * Shane, 2026-09-06: the Glass followed his phone to his daughter's while the
 * yacht sat on the hard. Order now: the bus, the Pi (which ranks the bus above
 * its u-blox stick), her held last fix, and the phone last — with the
 * boat-or-phone question as a centred modal that defaults to the boat.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const weatherContext = read('context/WeatherContext.tsx');
const orchestrator = read('services/WeatherOrchestrator.ts');
const controller = read('hooks/useAppController.ts');
const service = read('services/weatherPosition.ts');
const badges = read('components/dashboard/StatusBadges.tsx');
const glyph = read('components/GpsSourceGlyph.tsx');
const app = read('App.tsx');
const status = read('components/SystemStatusButton.tsx');
const dialog = read('components/dashboard/WeatherPositionChoiceDialog.tsx');

describe('the weather is for the boat', () => {
    it('the follower asks the boat before the phone, and the phone read stays passive', () => {
        const follow = weatherContext.slice(
            weatherContext.indexOf('const tick = () => {'),
            weatherContext.indexOf('const followTimer = setInterval(tick, GPS_FOLLOW_POLL_MS)'),
        );
        const chain = follow.indexOf('resolveWeatherPosition(');
        const phone = follow.indexOf('GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000 })');
        const decide = follow.indexOf('decideFollowAction({');
        expect(chain).toBeGreaterThan(-1);
        expect(phone).toBeGreaterThan(chain);
        expect(decide).toBeGreaterThan(phone);
        expect(follow).toContain('const { lat: latitude, lon: longitude } = resolved.fix;');
        expect(weatherContext).not.toContain('GpsService.getCurrentPosition(');
    });

    it('the boot path and both "Current Location" fetch paths use the same order, without asking', () => {
        expect(controller).toContain('resolveWeatherPosition(');
        expect(controller).toContain('{ mayAsk: false }');
        expect(orchestrator).toContain('private async weatherPositionOrPhone(');
        expect(orchestrator).toContain('this.weatherPositionOrPhone(60_000, 10)');
        expect(orchestrator).toContain('this.weatherPositionOrPhone(60_000, 15)');
        expect(orchestrator).not.toMatch(
            /getCurrentPositionIfGranted\(\{ staleLimitMs: 60_000, timeoutSec: 1[05] \}\)/,
        );
    });

    it('the service never reads the phone itself — that stays the caller’s call', () => {
        expect(service).not.toMatch(/GpsService|Geolocation|BgGeoManager|getCurrentPosition/);
        expect(service).toContain("from './boatPositionChain'");
        expect(service).toContain('export const ASK_DISTANCE_NM = 2;');
        expect(service).toContain('export const PI_POLL_MS = 30_000;');
    });

    it('which receiver the weather is for is a boat or a phone in the header — never a word on the page', () => {
        // Shane 2026-09-08: "just have a picture of a phone or a picture of a
        // little boat … remove all of the references to which gps we are using."
        // 2026-09-08 later: "lets move the phone or vessel gps icon into the i
        // section, rather than sticking yet another fab on the already jam
        // packed screen." The row lives in System Status; the header has no chip.
        expect(status).toContain('<GpsSourceRow />');
        expect(app).not.toContain('<GpsSourceGlyph />');
        expect(glyph).toContain("weatherKind === 'held'");
        expect(glyph).toContain('canChoose: true');
        expect(glyph).toContain('tap to choose the boat or this phone');
        expect(glyph).toContain('choice.open()');
        // The strip is the forecast age again: no receiver word, no second line.
        expect(badges).not.toContain("'PHONE'");
        expect(badges).not.toContain("'VESSEL'");
        expect(badges).not.toContain('mt-1 w-full text-center');
        expect(badges).toContain('<WeatherPositionChoiceDialog');
    });

    it('the question is a centred modal, and dismissing it keeps the boat', () => {
        expect(dialog).toContain('className="flex items-center justify-center p-4"');
        expect(dialog).toContain('onClick={chooseBoat}');
        expect(dialog).toContain('onEscape: chooseBoat');
        expect(dialog).toContain('Hold the boat');
        expect(dialog).toContain('Follow my phone');
    });
});
