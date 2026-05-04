import Foundation
import Capacitor
import MusicKit
import AVFoundation

/**
 * AppleMusicPlugin — MusicKit-based Apple Music control for Calypso.
 *
 * Rebuilt 2026-05-04 from MPMediaQuery / MPMusicPlayerController to
 * pure MusicKit. The old code couldn't play Apple Music subscription
 * content because all DRM-protected streaming tracks have nil
 * assetURL via the legacy APIs. MusicKit handles streaming
 * subscription content natively — full catalog access (~100M
 * tracks), proper coexistence with our app's audio session, and
 * fine-grained playback control.
 *
 * Authorization model: MusicAuthorization.request() prompts the
 * user with the modern MusicKit consent dialog (NSAppleMusicUsage-
 * Description in Info.plist). Required before any catalog access.
 *
 * Methods exposed to the JS layer:
 *   Authorization
 *     - requestMusicKitAuthorization
 *     - getMusicKitAuthorizationStatus
 *
 *   Catalog playback (search & play any Apple Music content)
 *     - searchAndPlay(query, kind?)
 *
 *   User library access
 *     - getUserPlaylists — returns user's library playlists with
 *       metadata + artwork URLs for the Music page UI
 *     - playPlaylist(id) — play a specific playlist by its
 *       MusicItemID
 *
 *   Playback control
 *     - pause / resume / next / previous / nowPlaying
 *
 *   TTS playback (separate AVAudioPlayer pipeline for Calypso's
 *   voice — preserved from previous implementation)
 *     - playTtsAudio(audio_b64)
 *     - cancelTtsAudio
 *
 * The developer token signing happens server-side via the Supabase
 * edge function `musickit-token`. The iOS layer fetches the token
 * lazily and caches in JS until expiry.
 */
@objc(AppleMusicPlugin)
public class AppleMusicPlugin: CAPPlugin {

    // ── TTS state (preserved from previous architecture) ────────────
    private var ttsPlayer: AVAudioPlayer?
    private var ttsPlayerDelegate: TtsPlayerDelegate?

    // ── Hydrated playlist cache ─────────────────────────────────────
    // After getPlaylistTracks hydrates a playlist via .with([.tracks]),
    // we stash the resulting Track array here keyed by playlist ID.
    // Subsequent playTrackInPlaylist / addPlaylistToQueue calls can
    // skip the (slow on large libraries) MusicLibraryRequest +
    // .with([.tracks]) round-trip and just use the cached objects.
    //
    // Stored as `Any` because `Track` is `@available(iOS 15.0, *)` —
    // class properties can't carry availability constraints, so we
    // erase the type and cast on use. The two helper methods below
    // contain the cast in one place.
    private var hydratedTrackCache: [String: Any] = [:]
    private var hydratedNameCache: [String: String] = [:]

    @available(iOS 15.0, *)
    private func cachePlaylist(id: String, name: String, tracks: [Track]) {
        hydratedTrackCache[id] = tracks
        hydratedNameCache[id] = name
    }

    @available(iOS 15.0, *)
    private func cachedPlaylist(id: String) -> (name: String, tracks: [Track])? {
        guard let tracks = hydratedTrackCache[id] as? [Track],
              let name = hydratedNameCache[id] else {
            return nil
        }
        return (name, tracks)
    }

    // MARK: - Authorization

    @available(iOS 15.0, *)
    @objc func requestMusicKitAuthorization(_ call: CAPPluginCall) {
        Task {
            let status = await MusicAuthorization.request()
            await MainActor.run {
                call.resolve([
                    "status": Self.authStatusString(status),
                    "granted": status == .authorized,
                ])
            }
        }
    }

    @available(iOS 15.0, *)
    @objc func getMusicKitAuthorizationStatus(_ call: CAPPluginCall) {
        let status = MusicAuthorization.currentStatus
        call.resolve([
            "status": Self.authStatusString(status),
            "granted": status == .authorized,
        ])
    }

    @available(iOS 15.0, *)
    private static func authStatusString(_ s: MusicAuthorization.Status) -> String {
        switch s {
        case .notDetermined: return "notDetermined"
        case .denied:        return "denied"
        case .restricted:    return "restricted"
        case .authorized:    return "authorized"
        @unknown default:    return "unknown"
        }
    }

    // MARK: - Catalog search + play

    /**
     * Search Apple Music catalog and play the best match. The kind
     * parameter narrows the search:
     *   "songs"     — only songs
     *   "albums"    — only albums
     *   "artists"   — only artists (plays top songs)
     *   "playlists" — only playlists
     *   "auto"      — tries artists → albums → playlists → songs
     *                  in priority order (most user intents map to
     *                  artist or album first)
     *
     * Returns the queue type matched + first track metadata so
     * Calypso can narrate "Playing Wish You Were Here by Pink Floyd"
     * without a follow-up nowPlaying call.
     */
    @available(iOS 15.0, *)
    @objc func searchAndPlay(_ call: CAPPluginCall) {
        guard let query = call.getString("query"), !query.isEmpty else {
            call.reject("query is required")
            return
        }
        let kindArg = call.getString("kind") ?? "auto"
        NSLog("[AppleMusic] searchAndPlay query='\(query)' kind=\(kindArg)")

        Task {
            // Authorization gate — request inline if notDetermined.
            let status = MusicAuthorization.currentStatus
            if status == .notDetermined {
                let newStatus = await MusicAuthorization.request()
                if newStatus != .authorized {
                    await MainActor.run {
                        call.resolve([
                            "status": "permission_denied",
                            "auth_status": Self.authStatusString(newStatus),
                        ])
                    }
                    return
                }
            } else if status != .authorized {
                await MainActor.run {
                    call.resolve([
                        "status": "permission_denied",
                        "auth_status": Self.authStatusString(status),
                    ])
                }
                return
            }

            let kindsToTry: [String]
            switch kindArg.lowercased() {
            case "songs", "song":           kindsToTry = ["songs"]
            case "artists", "artist":       kindsToTry = ["artists"]
            case "albums", "album":         kindsToTry = ["albums"]
            case "playlists", "playlist":   kindsToTry = ["playlists"]
            default:                        kindsToTry = ["artists", "albums", "playlists", "songs"]
            }

            // Track the first error we encounter — surfaced if no kind
            // returns a match, so the JS side can tell apart "Apple
            // legitimately has no Pink Floyd" from "MusicKit auth
            // failed, the app is missing an entitlement / capability".
            var firstError: String?
            for kind in kindsToTry {
                let outcome = await self.runCatalogSearch(query: query, kind: kind)
                switch outcome {
                case .match(let result):
                    NSLog("[AppleMusic] kind=\(kind) → playing '\(result.title)'")
                    let played = await self.startPlayback(result: result)
                    await MainActor.run {
                        if played {
                            call.resolve([
                                "status": "playing",
                                "matched_kind": kind,
                                "title": result.title,
                                "subtitle": result.subtitle,
                                "first_track_title": result.firstTrackTitle,
                                "first_track_artist": result.firstTrackArtist,
                                "track_count": result.trackCount,
                            ])
                        } else {
                            call.resolve([
                                "status": "playback_failed",
                                "matched_kind": kind,
                                "title": result.title,
                            ])
                        }
                    }
                    return
                case .empty:
                    continue
                case .failed(let msg):
                    if firstError == nil { firstError = msg }
                    continue
                }
            }

            // No match in any kind. Surface the underlying error if
            // there was one — usually means the app is missing the
            // MusicKit entitlement or the user has no subscription.
            if let err = firstError {
                NSLog("[AppleMusic] catalog search '\(query)' failed: \(err)")
                await MainActor.run {
                    call.resolve([
                        "status": "playback_failed",
                        "query": query,
                        "error": err,
                    ])
                }
                return
            }
            NSLog("[AppleMusic] no MusicKit catalog match for '\(query)'")
            await MainActor.run {
                call.resolve([
                    "status": "not_found",
                    "query": query,
                ])
            }
        }
    }

    /// Outcome of a single-kind catalog search. Distinguishes "Apple
    /// has nothing matching this term" from "the request itself
    /// failed" so the caller can produce a useful error.
    @available(iOS 15.0, *)
    private enum SearchOutcome {
        case match(CatalogResult)
        case empty
        case failed(String)
    }

    /// Internal search-result envelope.
    @available(iOS 15.0, *)
    private struct CatalogResult {
        let title: String
        let subtitle: String
        let firstTrackTitle: String
        let firstTrackArtist: String
        let trackCount: Int
        let queueSource: QueueSource
    }

    @available(iOS 15.0, *)
    private enum QueueSource {
        case songs([Song])
        case album(Album)
        case playlist(Playlist)
    }

    @available(iOS 15.0, *)
    private func runCatalogSearch(query: String, kind: String) async -> SearchOutcome {
        do {
            switch kind {
            case "songs":
                var req = MusicCatalogSearchRequest(term: query, types: [Song.self])
                req.limit = 25
                let resp = try await req.response()
                guard let song = resp.songs.first else { return .empty }
                return .match(CatalogResult(
                    title: song.title,
                    subtitle: song.artistName,
                    firstTrackTitle: song.title,
                    firstTrackArtist: song.artistName,
                    trackCount: 1,
                    queueSource: .songs([song])
                ))
            case "artists":
                var req = MusicCatalogSearchRequest(term: query, types: [Artist.self])
                req.limit = 5
                let resp = try await req.response()
                guard let artist = resp.artists.first else { return .empty }
                let detailedArtist = try await artist.with([.topSongs])
                guard let topSongs = detailedArtist.topSongs, !topSongs.isEmpty else {
                    return .empty
                }
                let songsArr = Array(topSongs)
                return .match(CatalogResult(
                    title: artist.name,
                    subtitle: "\(songsArr.count) tracks",
                    firstTrackTitle: songsArr.first?.title ?? "",
                    firstTrackArtist: songsArr.first?.artistName ?? artist.name,
                    trackCount: songsArr.count,
                    queueSource: .songs(songsArr)
                ))
            case "albums":
                var req = MusicCatalogSearchRequest(term: query, types: [Album.self])
                req.limit = 5
                let resp = try await req.response()
                guard let album = resp.albums.first else { return .empty }
                let detailedAlbum = try await album.with([.tracks])
                let trackCount = detailedAlbum.tracks?.count ?? 0
                let firstTrack = detailedAlbum.tracks?.first
                return .match(CatalogResult(
                    title: album.title,
                    subtitle: album.artistName,
                    firstTrackTitle: firstTrack?.title ?? "",
                    firstTrackArtist: firstTrack?.artistName ?? album.artistName,
                    trackCount: trackCount,
                    queueSource: .album(album)
                ))
            case "playlists":
                var req = MusicCatalogSearchRequest(term: query, types: [Playlist.self])
                req.limit = 5
                let resp = try await req.response()
                guard let playlist = resp.playlists.first else { return .empty }
                let detailedPlaylist = try await playlist.with([.tracks])
                let trackCount = detailedPlaylist.tracks?.count ?? 0
                let firstTrack = detailedPlaylist.tracks?.first
                return .match(CatalogResult(
                    title: playlist.name,
                    subtitle: playlist.curatorName ?? "Apple Music",
                    firstTrackTitle: firstTrack?.title ?? "",
                    firstTrackArtist: firstTrack?.artistName ?? "",
                    trackCount: trackCount,
                    queueSource: .playlist(playlist)
                ))
            default:
                return .empty
            }
        } catch {
            let msg = String(describing: error)
            NSLog("[AppleMusic] catalog search '\(kind)' failed: \(msg)")
            return .failed(msg)
        }
    }

    @available(iOS 15.0, *)
    private func startPlayback(result: CatalogResult) async -> Bool {
        let player = ApplicationMusicPlayer.shared
        do {
            // We avoid Queue(album:) and Queue(playlist:) here — those
            // initialisers on this SDK require non-optional startingAt
            // parameters with awkward types (Track for album,
            // Playlist.Entry for playlist) and there's no clean way to
            // express "just start from the top". Instead we hydrate the
            // tracks via .with([.tracks]) and pass them through the
            // Queue(for:) sequence init, which behaves the same way for
            // playback purposes.
            switch result.queueSource {
            case .songs(let songs):
                player.queue = ApplicationMusicPlayer.Queue(for: songs)
            case .album(let album):
                let detailed = try await album.with([.tracks])
                guard let tracks = detailed.tracks, !tracks.isEmpty else {
                    NSLog("[AppleMusic] album has no tracks: \(album.title)")
                    return false
                }
                player.queue = ApplicationMusicPlayer.Queue(for: tracks)
            case .playlist(let playlist):
                let detailed = try await playlist.with([.tracks])
                guard let tracks = detailed.tracks, !tracks.isEmpty else {
                    NSLog("[AppleMusic] playlist has no tracks: \(playlist.name)")
                    return false
                }
                player.queue = ApplicationMusicPlayer.Queue(for: tracks)
            }
            try await player.prepareToPlay()
            try await player.play()
            NSLog("[AppleMusic] ApplicationMusicPlayer.play() succeeded")
            return true
        } catch {
            NSLog("[AppleMusic] startPlayback error: \(error)")
            return false
        }
    }

    // MARK: - User library

    /**
     * Return the user's MusicKit library playlists. Used by the new
     * Music page in the app: tap a playlist → play it. Each playlist
     * carries id, name, curator, track count, and an artwork URL
     * the JS side can use directly in <img> src for the cover tile.
     */
    @available(iOS 15.0, *)
    @objc func getUserPlaylists(_ call: CAPPluginCall) {
        Task {
            let status = MusicAuthorization.currentStatus
            if status == .notDetermined {
                let newStatus = await MusicAuthorization.request()
                if newStatus != .authorized {
                    await MainActor.run {
                        call.resolve([
                            "status": "permission_denied",
                            "playlists": [],
                        ])
                    }
                    return
                }
            } else if status != .authorized {
                await MainActor.run {
                    call.resolve([
                        "status": "permission_denied",
                        "playlists": [],
                    ])
                }
                return
            }

            do {
                var req = MusicLibraryRequest<Playlist>()
                req.limit = 100
                let resp = try await req.response()
                // Return playlists fast — no track hydration here. The
                // earlier "hydrate every playlist with .with([.tracks])
                // in parallel via TaskGroup" approach hung for users
                // with many playlists; MusicKit doesn't appreciate
                // dozens of concurrent track-hydration requests. The JS
                // layer fetches preview tracks per-playlist in the
                // background after the grid renders, so the page loads
                // instantly and song lists fade in as previews arrive.
                let playlists: [[String: Any]] = resp.items.map { playlist in
                    var item: [String: Any] = [
                        "id": playlist.id.rawValue,
                        "name": playlist.name,
                        "curator": playlist.curatorName ?? "",
                    ]
                    if let artwork = playlist.artwork {
                        let url = artwork.url(width: 400, height: 400)
                        item["artwork_url"] = url?.absoluteString ?? ""
                    } else {
                        item["artwork_url"] = ""
                    }
                    item["preview_tracks"] = [] as [[String: String]]
                    return item
                }
                NSLog("[AppleMusic] getUserPlaylists → \(playlists.count) playlists (fast path, no hydration)")
                await MainActor.run {
                    call.resolve([
                        "status": "ok",
                        "playlists": playlists,
                    ])
                }
            } catch {
                NSLog("[AppleMusic] getUserPlaylists failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                        "playlists": [],
                    ])
                }
            }
        }
    }

    /**
     * Play a specific library playlist by its MusicItemID. The Music
     * page tap-to-play wires through here.
     */
    @available(iOS 15.0, *)
    @objc func playPlaylist(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required")
            return
        }
        Task {
            do {
                let req = MusicLibraryRequest<Playlist>()
                let resp = try await req.response()
                guard let playlist = resp.items.first(where: { $0.id.rawValue == id }) else {
                    await MainActor.run {
                        call.resolve(["status": "not_found", "id": id])
                    }
                    return
                }
                let player = ApplicationMusicPlayer.shared
                // Same Queue(for:) workaround as startPlayback() — the
                // Queue(playlist:) init wants a non-optional
                // Playlist.Entry for startingAt: on this SDK, so we
                // hydrate the tracks first and feed them through the
                // sequence-based init.
                let detailed = try await playlist.with([.tracks])
                guard let tracks = detailed.tracks, !tracks.isEmpty else {
                    await MainActor.run {
                        call.resolve([
                            "status": "error",
                            "error": "playlist has no tracks",
                        ])
                    }
                    return
                }
                player.queue = ApplicationMusicPlayer.Queue(for: tracks)
                try await player.prepareToPlay()
                try await player.play()
                let trackCount = tracks.count
                let firstTrack = tracks.first
                await MainActor.run {
                    call.resolve([
                        "status": "playing",
                        "playlist_name": playlist.name,
                        "track_count": trackCount,
                        "first_track_title": firstTrack?.title ?? "",
                        "first_track_artist": firstTrack?.artistName ?? "",
                    ])
                }
            } catch {
                NSLog("[AppleMusic] playPlaylist failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    // MARK: - Playlist detail (track list, queue ops)

    /**
     * Return all tracks in a user-library playlist with metadata for
     * the playlist-detail bottom sheet on the Music page. Each track
     * carries its id (so we can play-from-this-track later), title,
     * artist, duration in milliseconds, and a 200x200 artwork URL.
     */
    @available(iOS 15.0, *)
    @objc func getPlaylistTracks(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required")
            return
        }
        Task {
            do {
                let req = MusicLibraryRequest<Playlist>()
                let resp = try await req.response()
                guard let playlist = resp.items.first(where: { $0.id.rawValue == id }) else {
                    await MainActor.run {
                        call.resolve(["status": "not_found", "id": id])
                    }
                    return
                }
                let detailed = try await playlist.with([.tracks])
                let tracks = detailed.tracks ?? MusicItemCollection<Track>([])
                let trackArray = Array(tracks)
                // Cache the hydrated tracks so playTrackInPlaylist /
                // addPlaylistToQueue don't have to redo the slow
                // MusicLibraryRequest + .with([.tracks]) round-trip.
                self.cachePlaylist(id: id, name: playlist.name, tracks: trackArray)
                let trackList: [[String: Any]] = trackArray.map { track in
                    var item: [String: Any] = [
                        "id": track.id.rawValue,
                        "title": track.title,
                        "artist": track.artistName,
                        "duration_ms": Int((track.duration ?? 0) * 1000),
                    ]
                    if let url = track.artwork?.url(width: 200, height: 200) {
                        item["artwork_url"] = url.absoluteString
                    } else {
                        item["artwork_url"] = ""
                    }
                    return item
                }
                await MainActor.run {
                    call.resolve([
                        "status": "ok",
                        "playlist_name": playlist.name,
                        "tracks": trackList,
                    ])
                }
            } catch {
                NSLog("[AppleMusic] getPlaylistTracks failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    /**
     * Internal helper: resolve a playlist's hydrated tracks, preferring
     * the cache populated by getPlaylistTracks. Falls back to a fresh
     * MusicLibraryRequest + .with([.tracks]) only if the cache misses.
     */
    @available(iOS 15.0, *)
    private func resolveHydrated(id: String) async throws -> (name: String, tracks: [Track])? {
        if let cached = cachedPlaylist(id: id) {
            return cached
        }
        let req = MusicLibraryRequest<Playlist>()
        let resp = try await req.response()
        guard let playlist = resp.items.first(where: { $0.id.rawValue == id }) else {
            return nil
        }
        let detailed = try await playlist.with([.tracks])
        let trackArray = Array(detailed.tracks ?? MusicItemCollection<Track>([]))
        cachePlaylist(id: id, name: playlist.name, tracks: trackArray)
        return (playlist.name, trackArray)
    }

    /**
     * Replace the player's queue with a playlist's tracks and start
     * playing. Used by the detail sheet's "Play" button. We previously
     * also exposed a separate addPlaylistToQueue that used queue.insert
     * to append, but that path hung intermittently on iOS — replacing
     * the queue is the reliable behaviour and matches the "Play this
     * playlist" intent the skipper actually wants.
     */
    @available(iOS 15.0, *)
    @objc func addPlaylistToQueue(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required")
            return
        }
        Task {
            do {
                guard let resolved = try await resolveHydrated(id: id) else {
                    await MainActor.run {
                        call.resolve(["status": "not_found", "id": id])
                    }
                    return
                }
                guard !resolved.tracks.isEmpty else {
                    await MainActor.run {
                        call.resolve(["status": "error", "error": "playlist has no tracks"])
                    }
                    return
                }
                let player = ApplicationMusicPlayer.shared
                player.queue = ApplicationMusicPlayer.Queue(for: resolved.tracks)
                try await player.prepareToPlay()
                try await player.play()
                await MainActor.run {
                    call.resolve([
                        "status": "playing",
                        "playlist_name": resolved.name,
                        "track_count": resolved.tracks.count,
                    ])
                }
            } catch {
                NSLog("[AppleMusic] addPlaylistToQueue failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    /**
     * Play a specific track in a playlist, queuing the rest of the
     * playlist (from that track onwards) after it. Mirrors the
     * "tap-a-song-in-an-album" UX. Reads from the same hydrated
     * cache as addPlaylistToQueue so back-to-back interactions on
     * the same playlist don't re-fetch.
     */
    @available(iOS 15.0, *)
    @objc func playTrackInPlaylist(_ call: CAPPluginCall) {
        guard let playlistId = call.getString("playlist_id"), !playlistId.isEmpty else {
            call.reject("playlist_id is required")
            return
        }
        guard let trackId = call.getString("track_id"), !trackId.isEmpty else {
            call.reject("track_id is required")
            return
        }
        Task {
            do {
                guard let resolved = try await resolveHydrated(id: playlistId) else {
                    await MainActor.run {
                        call.resolve(["status": "not_found", "id": playlistId])
                    }
                    return
                }
                guard !resolved.tracks.isEmpty else {
                    await MainActor.run {
                        call.resolve(["status": "error", "error": "playlist has no tracks"])
                    }
                    return
                }
                guard let idx = resolved.tracks.firstIndex(where: { $0.id.rawValue == trackId }) else {
                    await MainActor.run {
                        call.resolve(["status": "track_not_found", "track_id": trackId])
                    }
                    return
                }
                let fromHere = Array(resolved.tracks[idx...])
                let player = ApplicationMusicPlayer.shared
                player.queue = ApplicationMusicPlayer.Queue(for: fromHere)
                try await player.prepareToPlay()
                try await player.play()
                let firstTrack = fromHere.first
                await MainActor.run {
                    call.resolve([
                        "status": "playing",
                        "title": firstTrack?.title ?? "",
                        "artist": firstTrack?.artistName ?? "",
                    ])
                }
            } catch {
                NSLog("[AppleMusic] playTrackInPlaylist failed: \(error)")
                await MainActor.run {
                    call.resolve([
                        "status": "error",
                        "error": String(describing: error),
                    ])
                }
            }
        }
    }

    // MARK: - Playback control

    @available(iOS 15.0, *)
    @objc func pause(_ call: CAPPluginCall) {
        ApplicationMusicPlayer.shared.pause()
        call.resolve(["status": "paused"])
    }

    @available(iOS 15.0, *)
    @objc func resume(_ call: CAPPluginCall) {
        Task {
            do {
                try await ApplicationMusicPlayer.shared.play()
                await MainActor.run { call.resolve(["status": "playing"]) }
            } catch {
                await MainActor.run {
                    call.resolve(["status": "failed", "error": String(describing: error)])
                }
            }
        }
    }

    @available(iOS 15.0, *)
    @objc func next(_ call: CAPPluginCall) {
        Task {
            try? await ApplicationMusicPlayer.shared.skipToNextEntry()
            await MainActor.run { call.resolve(["status": "skipped"]) }
        }
    }

    @available(iOS 15.0, *)
    @objc func previous(_ call: CAPPluginCall) {
        Task {
            try? await ApplicationMusicPlayer.shared.skipToPreviousEntry()
            await MainActor.run { call.resolve(["status": "skipped"]) }
        }
    }

    @available(iOS 15.0, *)
    @objc func nowPlaying(_ call: CAPPluginCall) {
        let player = ApplicationMusicPlayer.shared
        let state = player.state
        let isPlaying = state.playbackStatus == .playing
        let entry = player.queue.currentEntry

        var title = ""
        var artist = ""
        var album = ""
        var artworkUrl = ""
        if let entry = entry {
            title = entry.title
            switch entry.item {
            case .song(let song):
                artist = song.artistName
                album = song.albumTitle ?? ""
                if let url = song.artwork?.url(width: 400, height: 400) {
                    artworkUrl = url.absoluteString
                }
            default:
                break
            }
        }

        let stateString: String
        switch state.playbackStatus {
        case .playing:      stateString = "playing"
        case .paused:       stateString = "paused"
        case .stopped:      stateString = "stopped"
        case .interrupted:  stateString = "interrupted"
        case .seekingForward, .seekingBackward: stateString = "seeking"
        @unknown default:   stateString = "unknown"
        }

        call.resolve([
            "is_playing": isPlaying,
            "state": stateString,
            "title": title,
            "artist": artist,
            "album": album,
            "artwork_url": artworkUrl,
        ])
    }

    // MARK: - TTS playback (AVAudioPlayer)

    /**
     * Native TTS playback for Calypso. Bypasses WKWebView's HTML5
     * Audio entirely (which had its own audio session quirks). With
     * MusicKit's ApplicationMusicPlayer running music through its
     * own pipeline, AVAudioPlayer in our app session should mix
     * cleanly without interrupting the music.
     *
     * If music DOES get interrupted in practice, we'd add explicit
     * pause-resume around TTS — but MusicKit's playback is more
     * forgiving about session conflicts than the legacy
     * MPMusicPlayerController, so this should "just work".
     */
    @objc func playTtsAudio(_ call: CAPPluginCall) {
        guard let b64 = call.getString("audio_b64"), !b64.isEmpty else {
            call.reject("audio_b64 is required")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Cancel any in-flight TTS — single utterance at a time.
            if let prev = self.ttsPlayer {
                prev.stop()
                self.ttsPlayer = nil
            }
            self.ttsPlayerDelegate = nil

            guard let data = Data(base64Encoded: b64) else {
                call.reject("invalid base64 audio")
                return
            }

            do {
                let player = try AVAudioPlayer(data: data)
                player.volume = 1.0
                let delegate = TtsPlayerDelegate { [weak self] in
                    NSLog("[AppleMusic] playTtsAudio: playback finished")
                    DispatchQueue.main.async {
                        self?.ttsPlayer = nil
                        self?.ttsPlayerDelegate = nil
                        call.resolve(["status": "finished"])
                    }
                }
                player.delegate = delegate
                self.ttsPlayerDelegate = delegate
                self.ttsPlayer = player
                if !player.play() {
                    call.reject("AVAudioPlayer.play() returned false")
                    self.ttsPlayer = nil
                    self.ttsPlayerDelegate = nil
                    return
                }
                NSLog("[AppleMusic] playTtsAudio: started (\(data.count)B, \(String(format: "%.1f", player.duration))s)")
            } catch {
                NSLog("[AppleMusic] playTtsAudio: AVAudioPlayer init failed: \(error)")
                call.reject("AVAudioPlayer init failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func cancelTtsAudio(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.ttsPlayer?.stop()
            self?.ttsPlayer = nil
            self?.ttsPlayerDelegate = nil
            call.resolve(["status": "cancelled"])
        }
    }
}

/**
 * AVAudioPlayerDelegate that fires a closure when playback finishes
 * (or errors out). Used by playTtsAudio to resolve its CAPPluginCall
 * at the right moment.
 */
private final class TtsPlayerDelegate: NSObject, AVAudioPlayerDelegate {
    let onFinish: () -> Void
    init(onFinish: @escaping () -> Void) {
        self.onFinish = onFinish
    }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onFinish()
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        NSLog("[AppleMusic] TtsPlayer decode error: \(String(describing: error))")
        onFinish()
    }
}
