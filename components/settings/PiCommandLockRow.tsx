/**
 * "Only her own devices can command the Pi" (129-12): the owner's switch, in
 * Boat Pi under "Charts from <boat>". Live from Pi update 4; hidden on a Pi
 * that does not report it (today's Pi) and whenever her Pi cannot be asked,
 * never shown broken. It says where the switch is and what that means, how
 * many devices are set up, what devices not set up have tried since the Pi
 * started, and holds the switch, which only a phone set up for her can turn:
 * the Pi checks, and this one says so in the Pi's words, with the code field
 * just above. One short box (the menu-page rule).
 */
import React, { useEffect, useState } from 'react';
import { loadPiLock, setPiLockMode, type PiLockView } from '../../services/piCommandLock';
import { piRefusalWords } from '../../services/piCommandRefusal';
import { triggerHaptic } from '../../utils/system';

const TITLE = 'Only her own devices can command the Pi';
const small = 'text-[11px] leading-relaxed ';

/**
 * `reloadKey` changes when this phone is set up for her Pi (or a device is
 * taken off) in Charts from <boat> just above: the row asks her Pi again, so
 * it never says "not set up" under a phone that just was.
 */
export const PiCommandLockRow: React.FC<{ boatName: string; reloadKey?: number }> = ({ boatName, reloadKey = 0 }) => {
    const [lock, setLock] = useState<PiLockView | null>(null);
    const [busy, setBusy] = useState(false);
    const [said, setSaid] = useState<string | null>(null);
    const boat = boatName.trim() || 'your boat';

    useEffect(() => {
        let live = true;
        // A reload keeps what it showed until her Pi answers: no blink.
        void loadPiLock().then((view) => live && setLock(view));
        return () => {
            live = false;
        };
    }, [reloadKey]);

    if (!lock) return null;
    const on = lock.mode === 'enforce';
    const mine = lock.thisDevice === 'set-up';
    const devices = `${lock.devices} ${lock.devices === 1 ? 'device' : 'devices'}`;
    const state = !on
        ? `Off: any phone on ${boat}'s Wi-Fi can change her Pi.`
        : lock.enforcing
          ? `On: only the ${devices} set up for ${boat} can change her Pi.`
          : `On, but no device is set up for ${boat}, so her Pi answers everyone.`;
    const flip = () => {
        triggerHaptic('light');
        setBusy(true);
        setSaid(null);
        void setPiLockMode(on ? 'observe' : 'enforce')
            .then((answer) => ('said' in answer ? setSaid(answer.said) : setLock(answer)))
            .finally(() => setBusy(false));
    };

    return (
        <div className="space-y-1.5 rounded-xl border border-white/5 bg-white/3 p-3" data-testid="pi-command-lock">
            <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-sm font-bold text-white">{TITLE}</p>
                <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={TITLE}
                    disabled={busy || !mine}
                    onClick={flip}
                    className="relative inline-flex min-h-[44px] shrink-0 items-center px-1 disabled:opacity-40"
                >
                    <span className={`h-6 w-11 rounded-full transition-colors ${on ? 'bg-sky-500' : 'bg-slate-500'}`} />
                    <span
                        className={`absolute h-4 w-4 rounded-full bg-white shadow-md transition-all ${on ? 'left-7' : 'left-2'}`}
                    />
                </button>
            </div>
            <p className={small + (on ? 'text-emerald-300' : 'text-gray-300')}>{state}</p>
            <p className={small + 'text-gray-400'}>Anyone aboard can still see the watches and raise an alarm.</p>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{devices} set up</p>
            <p className={small + 'text-gray-400'}>
                {lock.seen.length > 0
                    ? `Seen without a code since the Pi started: ${lock.seen.map((s) => `${s.words} ×${s.calls}`).join(', ')}`
                    : 'Nothing from a device not set up since the Pi started.'}
            </p>
            {!mine && (
                <p className={small + 'text-amber-300'}>
                    {piRefusalWords(lock.thisDevice === 'removed' ? 'pi-device-removed' : 'pi-device-not-set-up', boat)}
                </p>
            )}
            {said && (
                <p aria-live="polite" className={small + 'text-amber-300'}>
                    {said}
                </p>
            )}
        </div>
    );
};
