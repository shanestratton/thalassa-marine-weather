/**
 * useFollowedBoatKey — which boat 'Current Location' follows, as a key that
 * changes whenever the followed receiver does ('boat', or 'crew:<skipper id>'),
 * or null while it follows the phone (or a crewed boat whose skipper is not
 * known here). For the Wind panel's "Her wind vs the models" row, which is
 * offered only while a boat is followed.
 *
 * Re-read on the follow target event (a pick, Switch boat, the end of the
 * crewing) and on an account change, which brings that account's own choice.
 */
import { useSyncExternalStore } from 'react';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import {
    WEATHER_FOLLOW_TARGET_EVENT,
    getWeatherFollowCrewOwner,
    getWeatherFollowKey,
    getWeatherFollowTarget,
} from '../../services/weatherPosition';

function subscribe(onChange: () => void): () => void {
    window.addEventListener(WEATHER_FOLLOW_TARGET_EVENT, onChange);
    const offIdentity = subscribeAuthIdentityScope(() => onChange());
    return () => {
        window.removeEventListener(WEATHER_FOLLOW_TARGET_EVENT, onChange);
        offIdentity();
    };
}

function followedBoatKey(): string | null {
    try {
        const target = getWeatherFollowTarget();
        if (target === 'phone' || (target === 'crew' && !getWeatherFollowCrewOwner())) return null;
        return getWeatherFollowKey();
    } catch {
        return null;
    }
}

export function useFollowedBoatKey(): string | null {
    return useSyncExternalStore(subscribe, followedBoatKey, () => null);
}
