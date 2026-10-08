/** Closed package namespaces. No production native package is imported. Unknown
 * native calls reject; these are neither permission nor hardware observations. */
import { registerPlugin } from './core';
export const App = registerPlugin('DeniedApp');
export const Browser = registerPlugin('DeniedBrowser');
export const Filesystem = registerPlugin('DeniedFilesystem');
export const Geolocation = registerPlugin('DeniedGeolocation');
export const Haptics = registerPlugin('DeniedHaptics');
export const Keyboard = registerPlugin('DeniedKeyboard');
export const LocalNotifications = registerPlugin('DeniedLocalNotifications');
export const Network = registerPlugin('DeniedNetwork');
export const Share = registerPlugin('DeniedShare');
export const StatusBar = registerPlugin('DeniedStatusBar');
export const SignInWithApple = registerPlugin('DeniedSignInWithApple');
export const SpeechRecognition = registerPlugin('DeniedSpeechRecognition');
export const BackgroundGeolocation = registerPlugin('DeniedBackgroundGeolocation');
export const BackgroundFetch = registerPlugin('DeniedBackgroundFetch');
export const NativeAudio = registerPlugin('DeniedNativeAudio');
// Enum values describe API vocabulary only; no filesystem/native action runs.
export const Directory = Object.freeze({
    Documents: 'DOCUMENTS',
    Data: 'DATA',
    Cache: 'CACHE',
    Library: 'LIBRARY',
    External: 'EXTERNAL',
    ExternalStorage: 'EXTERNAL_STORAGE',
});
export const Encoding = Object.freeze({ UTF8: 'utf8', ASCII: 'ascii', UTF16: 'utf16' });
export const ImpactStyle = Object.freeze({ Heavy: 'HEAVY', Medium: 'MEDIUM', Light: 'LIGHT' });
export const NotificationType = Object.freeze({ Success: 'SUCCESS', Warning: 'WARNING', Error: 'ERROR' });
export const KeyboardResize = Object.freeze({ Body: 'body', Ionic: 'ionic', Native: 'native', None: 'none' });
export const KeyboardStyle = Object.freeze({ Dark: 'DARK', Light: 'LIGHT', Default: 'DEFAULT' });
export const Style = Object.freeze({ Dark: 'DARK', Light: 'LIGHT', Default: 'DEFAULT' });
