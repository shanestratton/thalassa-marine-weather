/**
 * Settings → Preferences → "If the boat goes quiet" (129-08): the cloud
 * watchdog that pages when the boat's Pi, or her instruments, fall silent.
 *
 *  - The skipper's switch turns the watch on or off for the boat, and writes
 *    its weekly window (default Wed 19:30-19:50) in the boat's own zone: the
 *    ship's clock zone when one is set, else the place the weather follows,
 *    else this phone's. A window already set is kept as it is.
 *  - A crew member with Share Instrument Panel gets one switch per boat, to
 *    turn these pages off (or back on) for themselves only.
 *  - Nothing shows until its probe answers (services/boatQuiet/quietWatchService.ts),
 *    so no switch is offered that nothing honours.
 *  - The words are boatLinkModel's (describeQuietWatch): it hears her only
 *    while her Pi may use the internet.
 */
import React from 'react';
import { Row, Section, Toggle } from './SettingsPrimitives';
import { useAuthStore } from '../../stores/authStore';
import { useWeatherOptional } from '../../context/WeatherContext';
import { readShipClockPrefs, SHIP_ZONE_AUTO } from '../../services/shipClockPrefs';
import { deviceTimeZone } from '../../utils/timeZones';
import { describeQuietWatch } from '../../services/boatLink/boatLinkModel';
import {
    DEFAULT_QUIET_WINDOW,
    loadQuietWatch,
    saveOwnerQuietWatch,
    setCrewQuietPage,
    type QuietWatchView,
    type QuietWindow,
} from '../../services/boatQuiet/quietWatchService';

const SAVE_FAILED = 'Couldn’t save that. Check your connection and try again.';
const SAVE_REFUSED = 'Couldn’t save that: the server refused the change.';

export const BoatQuietSection: React.FC<{ satellite: boolean }> = ({ satellite }) => {
    const userId = useAuthStore((s) => (s.user as { id?: string } | null)?.id ?? null);
    const weatherZone = useWeatherOptional()?.weatherData?.timeZone ?? null;
    const [view, setView] = React.useState<QuietWatchView | null>(null);
    const [failed, setFailed] = React.useState<'refused' | 'failed' | null>(null);

    React.useEffect(() => {
        setView(null);
        if (!userId) return;
        let live = true;
        void loadQuietWatch(userId).then((next) => {
            if (live) setView(next);
        });
        return () => {
            live = false;
        };
    }, [userId]);

    if (!userId || !view || (!view.owner && view.crew.length === 0)) return null;
    const { owner, crew, crewPaging } = view;

    const shipZone = readShipClockPrefs().zone;
    const window: QuietWindow = owner?.window ?? {
        ...DEFAULT_QUIET_WINDOW,
        tz: shipZone !== SHIP_ZONE_AUTO ? shipZone : (weatherZone ?? deviceTimeZone()),
    };

    const saveOwner = async (on: boolean) => {
        if (!owner) return;
        setFailed(null);
        setView((v) => v && { ...v, owner: { ...owner, enabled: on, window } });
        const saved = await saveOwnerQuietWatch(userId, on, window);
        if (saved === 'saved') return;
        setView((v) => v && { ...v, owner });
        setFailed(saved);
    };

    const saveCrew = async (ownerId: string, on: boolean) => {
        setFailed(null);
        const flip = (pagingMe: boolean) =>
            setView((v) => v && { ...v, crew: v.crew.map((b) => (b.ownerId === ownerId ? { ...b, pagingMe } : b)) });
        flip(on);
        const saved = await setCrewQuietPage(ownerId, on);
        if (saved === 'saved') return;
        flip(!on);
        setFailed(saved);
    };

    return (
        <Section title="If the boat goes quiet">
            {owner && (
                <Row>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm text-white font-medium">Page if the boat goes quiet</p>
                        <p className="text-xs text-gray-400">
                            {describeQuietWatch({
                                role: 'owner',
                                watchOn: owner.enabled,
                                graceMin: owner.graceMin,
                                window,
                                satellite,
                                crewPaging,
                            })}
                        </p>
                    </div>
                    <Toggle
                        label="Page if the boat goes quiet"
                        checked={owner.enabled}
                        onChange={(on) => void saveOwner(on)}
                    />
                </Row>
            )}
            {crew.map((boat) => {
                const label = `Page me if ${boat.boatName ?? 'the boat'} goes quiet`;
                return (
                    <Row key={boat.ownerId}>
                        <div className="flex-1 min-w-0" style={{ overflowWrap: 'anywhere' }}>
                            <p className="text-sm text-white font-medium">{label}</p>
                            <p className="text-xs text-gray-400">
                                {describeQuietWatch({
                                    role: 'crew',
                                    watchOn: boat.watchOn,
                                    graceMin: 15,
                                    window: null,
                                    satellite: false,
                                    crewPaging,
                                    pagingMe: boat.pagingMe,
                                })}
                            </p>
                        </div>
                        <Toggle
                            label={label}
                            checked={boat.pagingMe}
                            onChange={(on) => void saveCrew(boat.ownerId, on)}
                        />
                    </Row>
                );
            })}
            {failed && (
                <p role="status" className="px-4 pb-3 text-xs text-amber-300">
                    {failed === 'refused' ? SAVE_REFUSED : SAVE_FAILED}
                </p>
            )}
        </Section>
    );
};
