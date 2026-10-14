// The weather narrative that lived here is gone (130-04): it had no caller
// outside its own test, and it called 1.2 m (4 ft) "Rough seas", where WMO
// code 3700 says Moderate. Sea-state words come from utils/marineFormatters.

// Moon phase calculation using accurate synodic month
function getMoonPhase(date: Date): { phase: string; emoji: string } {
    // Known new moon reference: January 6, 2000 at 18:14 UTC
    const knownNewMoon = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));

    // Synodic month length (average time between new moons)
    const synodicMonth = 29.53058770576;

    // Calculate days since the known new moon
    const daysSinceNewMoon = (date.getTime() - knownNewMoon.getTime()) / (1000 * 60 * 60 * 24);

    // Get the current position in the lunar cycle (0 to 1)
    let lunarAge = daysSinceNewMoon / synodicMonth;
    lunarAge = lunarAge - Math.floor(lunarAge); // Get fractional part (0 to 1)

    // Convert to 8 phases (0-7)
    // 0 = New Moon, 1 = Waxing Crescent, 2 = First Quarter, 3 = Waxing Gibbous
    // 4 = Full Moon, 5 = Waning Gibbous, 6 = Last Quarter, 7 = Waning Crescent
    const phaseIndex = Math.round(lunarAge * 8) % 8;

    const phases = [
        { phase: 'New', emoji: '🌑' },
        { phase: 'Waxing Crescent', emoji: '🌒' },
        { phase: 'First Quarter', emoji: '🌓' },
        { phase: 'Waxing Gibbous', emoji: '🌔' },
        { phase: 'Full', emoji: '🌕' },
        { phase: 'Waning Gibbous', emoji: '🌖' },
        { phase: 'Last Quarter', emoji: '🌗' },
        { phase: 'Waning Crescent', emoji: '🌘' },
    ];

    return phases[phaseIndex];
}

export { getMoonPhase };
