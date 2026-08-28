/**
 * How the app says numbers over a radio.
 *
 * One module, because the MOB page and the Radio Console were drifting: the
 * MOB Mayday had already been moved to comma-separated digits while the Radio
 * Console still joined them with SPACES, which is not a pause to any engine —
 * it reads "5 0 3" as "five hundred and three", or races the run together.
 *
 * Everything here exists to be COPIED DOWN by someone with a pencil, on a
 * bad channel, once. That is a different job from sounding natural, and where
 * the two conflict, copying wins.
 */

/** Below this, in knots, a vessel is not making way in any useful sense. */
const STATIONARY_KTS = 0.2;

/**
 * Digit runs are grouped in threes, because that is the span a listener can
 * hold and write before the next one arrives (Shane 2026-08-28: "the human
 * brain loves threes, so a pause after each 3 numbers"). A comma separates
 * digits, a full stop separates groups — a full stop is the longest prosodic
 * break punctuation can buy, and it is honoured by every engine we use,
 * unlike SSML, which the native fallback would read out loud as tags.
 *
 * Short runs are NOT grouped. A four-digit UTC time chunked into threes reads
 * "two, two, four. two", which is worse than not grouping at all — so the
 * grouping only starts where there is enough to be worth breaking up. A
 * nine-digit MMSI divides perfectly into three.
 */
export function spellDigits(value: string): string {
    const chars = [...String(value).trim()].filter((c) => c !== ' ');
    if (chars.length === 0) return '';
    if (chars.length < 6) return chars.join(', ');
    const groups: string[][] = [];
    for (let i = 0; i < chars.length; i += 3) groups.push(chars.slice(i, i + 3));
    // A trailing group of one leaves a digit stranded after a full stop —
    // "four, one, two. three" — which sounds like the end of the number and
    // then an afterthought. Fold it back into the group before it.
    if (groups.length > 1 && groups[groups.length - 1].length === 1) {
        const orphan = groups.pop() as string[];
        groups[groups.length - 1].push(...orphan);
    }
    return groups.map((g) => g.join(', ')).join('. ');
}

/**
 * "MMSI" and "Call sign" are labels, not part of the number, and running
 * them into the digits is what made the old readout unusable — the listener
 * is still parsing the word when the first digit goes past. The full stop
 * gives them the beat they need to get the pencil moving.
 */
export function spokenMmsi(mmsi: string): string {
    return `M M S I. ${spellDigits(mmsi)}. `;
}

export function spokenCallSign(callSign: string): string {
    return `Call sign. ${spellDigits(callSign)}. `;
}

/**
 * Minutes are spelled out like the degrees above them, and for the same
 * reason: the degree integer is already spelled digit-by-digit because
 * ElevenLabs was caught reading "153 degrees" as "53 degrees". Minutes carry
 * the same risk and matter just as much — a tenth of a minute is 185 m — so
 * "two eight decimal five" rather than "twenty-eight point five". "Decimal"
 * is the radio word for the point.
 */
function spokenMinutes(minutes: string): string {
    const [whole, frac] = minutes.split('.');
    const wholeSpoken = [...whole].join(', ');
    return frac === undefined ? wholeSpoken : `${wholeSpoken}, decimal, ${frac}`;
}

/**
 * A position, slowed to writing speed (Shane 2026-08-28: "the lat and long
 * needs to be slowed down as well"). Commas inside each half, a full stop
 * between latitude and longitude — that gap is where the listener finishes
 * the first line and moves to the second.
 */
export function formatSpokenPosition(lat: number, lon: number): string {
    const half = (v: number, pos: string, neg: string): string => {
        const abs = Math.abs(v);
        const deg = Math.floor(abs);
        const min = ((abs - deg) * 60).toFixed(1);
        return `${[...String(deg)].join(', ')}, degrees. ${spokenMinutes(min)}, minutes. ${v >= 0 ? pos : neg}`;
    };
    return `${half(lat, 'North', 'South')}. ${half(lon, 'East', 'West')}`;
}

/**
 * Speed over ground.
 *
 * A vessel cannot make negative way over the ground, so a negative reading is
 * the GPS saying it has no speed solution — some platforms return a sentinel
 * rather than null, and `null * 1.94384` is 0, so the negatives that reach
 * here are sentinels or noise around a standstill. Either way the boat is not
 * moving, and "minus one point nine knots" on a distress call is worse than
 * useless (Shane 2026-08-28: "if it is Negative, then it should say
 * stationary").
 *
 * Near-zero says the same thing for the same reason: "zero point zero knots"
 * is a number where a word will do.
 */
export function spokenSpeedOverGround(sogKts: number): string {
    if (!Number.isFinite(sogKts)) return 'Speed over ground unavailable. ';
    if (sogKts < STATIONARY_KTS) return 'Stationary. ';
    return `Speed over ground ${sogKts.toFixed(1)} knots. `;
}

/**
 * A bearing, spelled like every other number in a position report.
 *
 * "Course 105 degrees true" was the one clause left reading as a cardinal
 * number, in the same breath as a position whose degrees are spelled out
 * precisely because an engine was caught dropping a leading digit. Same
 * risk, same stakes, same treatment.
 */
export function spokenBearing(deg: number): string {
    const rounded = Math.round(((deg % 360) + 360) % 360);
    return `${[...String(rounded).padStart(3, '0')].join(', ')}, degrees true`;
}
