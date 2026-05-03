#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// AppleMusicPlugin — Objective-C bridge for Capacitor
// Registers the Swift native Apple Music plugin (MediaPlayer.framework
// based — library reads + system playback control). The JS side calls
// methods via `registerPlugin<...>('AppleMusic')`.

CAP_PLUGIN(AppleMusicPlugin, "AppleMusic",
    CAP_PLUGIN_METHOD(requestAuthorization, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getAuthorizationStatus, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getLibraryStats, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(playFirstSong, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(searchAndPlay, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(pause, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(resume, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(next, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(previous, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(nowPlaying, CAPPluginReturnPromise);
)
