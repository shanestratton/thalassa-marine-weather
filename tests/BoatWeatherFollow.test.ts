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

    it('the Glass says which receiver the weather is for — one word in the SAME row as the age, never a new line', () => {
        expect(badges).toContain('describeWeatherFix(positionSource, ageTick)');
        expect(badges).toContain("positionSource.kind === 'phone' ? 'PHONE' : 'VESSEL'");
        expect(badges).toContain('· tap to change');
        // Shane, 2026-09-07 (103 matrix): "we have no spare real estate to add
        // lines to the page" — the full-width receiver line under the row is gone
        // for good; the word rides beside the forecast age instead.
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
