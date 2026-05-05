#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// AppleMusicPlugin — Capacitor bridge for the MusicKit-based Swift
// plugin. Methods exposed to JS via registerPlugin('AppleMusic').

CAP_PLUGIN(AppleMusicPlugin, "AppleMusic",
    // Authorization
    CAP_PLUGIN_METHOD(requestMusicKitAuthorization, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getMusicKitAuthorizationStatus, CAPPluginReturnPromise);
    // Catalog playback
    CAP_PLUGIN_METHOD(searchAndPlay, CAPPluginReturnPromise);
    // User library
    CAP_PLUGIN_METHOD(getUserPlaylists, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(playPlaylist, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(playLibraryPlaylist, CAPPluginReturnPromise);
    // Playlist detail (long-press sheet on the Music page)
    CAP_PLUGIN_METHOD(getPlaylistTracks, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(addPlaylistToQueue, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(playTrackInPlaylist, CAPPluginReturnPromise);
    // Library mutations
    CAP_PLUGIN_METHOD(createPlaylist, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(addCurrentTrackToPlaylist, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(searchCatalogSongs, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(addSongToPlaylist, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(deletePlaylist, CAPPluginReturnPromise);
    // Playback control
    CAP_PLUGIN_METHOD(pause, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(resume, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(next, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(previous, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(nowPlaying, CAPPluginReturnPromise);
    // TTS
    CAP_PLUGIN_METHOD(playTtsAudio, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(cancelTtsAudio, CAPPluginReturnPromise);
)
