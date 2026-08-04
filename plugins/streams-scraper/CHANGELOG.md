# Changelog

## 1.0.53

- Night mode toggle in the player menu works: setNightMode never announced
  its change, so the toggle wrote the value without applying it. Menu labels
  shortened.

## 1.0.52

- Night mode / DRC can be toggled from the player's ⋯ menu (Off → Mild →
  Strong) and applies immediately, mid-playback.

## 1.0.51

- Night mode logs mpv's live audio-filter chain after applying, so a dropped
  filter is visible in the debug log instead of silent.

## 1.0.50

- Night mode / DRC now applies reliably: the audio filter is set when the
  file loads instead of at player mount, where a not-yet-initialized mpv
  silently dropped it.

## 1.0.49

- Cast preparation resolves the source redirect chain itself (with retries
  on 5xx) and hands ffmpeg — and direct-play receivers — the final CDN URL,
  so a flaky resolver can no longer kill the start.
- The stream is handed over with an ~8 second buffer cushion so the
  receiver never joins on a bare first segment.
- The AirPlay availability listener re-attaches once (WebKit occasionally
  reports not-available on first attach despite receivers being present).

## 1.0.48

- Cast preparation now verifies the server is reachable on the LAN before
  handing out a stream (a boot that bound loopback-only used to leave the
  cast stuck on "preparing" forever) and surfaces media element errors
  in diagnostics.
- Faster cast startup: 1-second opener segments make the stream ready
  seconds sooner.

## 1.0.47

- The AirPlay row now unlocks when the stream is actually buffered
  (canplay), not merely described — WebKit silently refuses to hand
  unbuffered media to the receiver, which left the TV idle on a picked
  route.

## 1.0.46

- Casting rebuilt on the proven direct-playlist flow: the preroll/splice
  experiment is removed entirely (Apple's HLS spec requires discontinuities
  to be synchronized across renditions, and old receivers reject format
  changes at them — the source of every large-file stall). Every transcode
  is letterboxed to a constant 1920x1080 canvas, subtitles ride as an
  instantly-served static WebVTT rendition, and the receiver shows its own
  loading UI while the stream spins up.

## 1.0.45

- Subtitles on AirPlay finally work — delivered as a native HLS WebVTT
  rendition the receiver renders itself (auto-shown, toggleable in the TV
  player). Burn-in is gone: no reachable ffmpeg build ships the subtitles
  filter, which was silently killing every subtitled transcode (and, on big
  files, the whole cast).
- The preroll shows a "Laddar strömmen …" title card instead of plain
  black while the transcode spins up.
- Dead transcodes now end the session immediately (the receiver errors out
  instead of looping the loading card forever) — fixes large files never
  starting.

## 1.0.44

- The black preroll is now parameter-matched to the movie transcode (1080p
  H.264 main profile, 48 kHz stereo AAC) and the transcode pins a 4 s
  keyframe cadence — older AirPlay receivers (Apple TV HD) stall when the
  splice asks them to reconfigure resolution/audio mid-stream.

## 1.0.43

- Fixes the receiver stalling right after the preroll splice: transcoded
  segments carried absolute source timestamps, so the TV waited forever for
  media that claimed to sit ~20 minutes away (and showed that as the clip
  duration). Timestamps are now rebased to zero at the muxer.
- Flaky transcode starts (the CDN refusing the extra connection next to the
  local player) retry automatically with backoff instead of surfacing as an
  instant "failed" row, and ffmpeg errors are captured for diagnostics.

## 1.0.42

- AirPlay handover finally holds: picking a receiver used to drop the route
  the instant the app swapped the placeholder for the real stream (WebKit
  resets the playback target on source changes). The session playlist now
  starts as instantly-playable black preroll and the transcode is spliced in
  server-side — one source for the element's whole life, so the picked route
  survives and the movie starts on the TV.

## 1.0.41

- Fixes 1.0.40's pick-first flow (the placeholder URL never reached the
  session state, so the instant picker could route a dead source).

## 1.0.40

- Pick-first AirPlay: the device picker opens the moment the cast menu is
  ready (a tiny instant clip is routed first), and the real stream loads on
  the receiver after you pick it — no more waiting in the menu while a slow
  source spins up. Matches how other casting apps behave.

## 1.0.39

- The AirPlay row additionally waits for the stream's metadata before
  unlocking — WebKit's device picker silently ignores clicks while the media
  element has nothing loaded, which made a ready-looking row do nothing on
  slow-starting transcodes.

## 1.0.38

- The AirPlay row now unlocks when WebKit reports a wireless target is
  actually available (its picker silently ignores clicks before the stream
  is routable) — fixes the ready-looking row that did nothing when clicked
  right after opening the menu.

## 1.0.37

- AirPlay preparation is near-instant: the transcode session now answers as
  soon as ffmpeg is running and the receiver waits in the stream itself, so
  slow network seeks no longer stall (or fail) the cast menu for minutes.
- The AirPlay row shows a tappable "failed — retry" state instead of
  sticking on "Preparing stream…" forever when preparation fails.

## 1.0.36

- Faster AirPlay preparation: only externally loaded subtitles are burned in
  (embedded MKV tracks made ffmpeg rescan the whole remote file and blew the
  init timeout before falling back anyway — pick a subtitle in the CC menu
  and it follows the cast).
- Clearer cast menu copy: the AirPlay row says "Preparing stream…" instead of
  a device-search message, and the empty state only refers to Chromecast/DLNA.
- Handover breadcrumb logging for diagnosing route/pause issues.

## 1.0.35

- The embedded player now carries the app's casting support: the cast menu
  (Chromecast/DLNA device list plus the new AirPlay flow) is available when
  playing through the plugin, instead of the pre-casting player this runtime
  was last built against.
- AirPlay rides WebKit's video target picker with an H.264 ≤1080p hardware
  transcode for MKV/HEVC sources, burned-in active subtitles, and automatic
  mpv handover/handback. Requires app 0.2.21+ for the preparation endpoint —
  on older apps the AirPlay row shows a cast error and the rest of the menu
  works as before.

## 1.0.34

- Remembered-stream matching survives re-searches: scrapers return url-only results (no infoHash field), so the torrent hash is now pulled out of the URL, with the release name as a final fallback. Previously an exact URL match was required, which a regenerated token or host would break — silently dropping back to the ranked list.
- New `remembered stream lookup` telemetry states whether a saved stream existed and where it landed in the candidate list, so a resume picking the "wrong" source is diagnosable instead of guesswork.

## 1.0.33

- Resume reuses the stream that actually played. The source is remembered per title/episode (explicit sidebar picks too) and tried first on the next play, so "Fortsätt" starts on the same source and skips re-racing the ranked list — with the normal candidate order still available as fallback if that source has since disappeared.

## 1.0.32

- Reports the settled stream count to the host (`onStreamsResult`) so the app can hide Play/Download on titles where the search found nothing, instead of offering a click that must fail.

## 1.0.31

- Plugin UI now follows the app's language picker (rebuilt against the host's fixed i18n module — plugin bundles used to be stuck on the English default because the host's language context never reached their bundled copy).

## 1.0.30

- TorrentsDB retired as a scraper. Its playback URLs are rate-limited server-side (HTTP 429 "Too many requests") even for streams it labels as cached, so every play attempt through it failed. The preset is no longer offered in settings, and already-configured TorrentsDB scrapers are dropped automatically on load — no user action needed.

## 1.0.29

- Per-candidate start window raised 12 s → 20 s. Torrentio `/resolve` URLs routinely need 10-15 s before first byte and play fine manually — the 12 s window abandoned the working first stream moments before it started, then burned 12 s on the next slow candidate (~30 s to playback). Real failures (e.g. torrentsdb's HTTP 429 rate-limited playback URLs, whose CACHED badge is label-only) still advance in under a second via the player's load-failed signal; only silently hanging sources pay the full window.

## 1.0.28

- Autoplay candidates now follow the sidebar's own display order, top-down, up to 5 streams — pressing play behaves like clicking the visible list until one plays. Previously the candidate builder resolved to the HOST app's copy (build-time `@/lib` aliasing), which reordered by cached-flag/language and capped at 3; on real lookups that picked three dud url-only sources and skipped the very stream a manual click on the first row plays. The max-size setting is now a preference (within-cap streams first) instead of a veto.
- The "Startar avsnitt/film…" splash is dismissed when every candidate fails (it used to stay up forever once the close-path stopped running in 1.0.27) — the stream sidebar opens instead.
- Play-request tokens are now consumed across remounts (module-level guard) and cleared on manual stream clicks and player close, so a finished/failed play request can no longer replay itself and throw up a ghost loading screen after the user moved on.
- Telemetry: `autoplay resolve start` now logs the consuming token; new `pending play request consumed` event.

## 1.0.27

- Fixed the actual reason play buttons bounced to home/detail even though 1.0.26's retry loop was in place: the player's dead-stream escape hatch (mpv end-file error before first frame, typically its ~10 s network timeout on a dead mediafusion URL) closed the whole playback session mid-loop, cancelling the attempt before candidates 2+ were tried. The player now reports the failure to the autoplay loop (which keeps the modal open, swaps in the next stream immediately instead of waiting out the 12 s window) and only closes when no loop is driving it.
- Autoplay now tries up to 5 streams top-down (was 3), matching manually clicking through the sidebar until one plays.

## 1.0.26

- Play buttons (Spela/hero/detail/continue) now play like a manual sidebar click that works: they try each stream in the player and, if playback does not actually start (verified via the player's first-frame event), automatically advance to the next stream — instead of committing to the first (often dead) source. Dead/unplayable sources are skipped without exiting to the home/detail view. Replaces the unreliable URL probe.

## 1.0.25

- Autoplay now verifies a direct stream URL is actually alive (probe) before committing to it. Previously "Spela" opened a player on the first (often dead) mediafusion/torbox URL, stalled, and never tried the next working stream — so it bounced back with no playback even though a later stream in the list plays fine. It now skips dead URLs and plays the first that works, matching a manual click on a working stream.

## 1.0.24

- Diagnostics: autoplay now logs candidate counts, whether each candidate has a direct URL vs infoHash, the resolve outcome, and the running plugin version — so a failed "Spela" pinpoints exactly where it breaks.

## 1.0.23

- Autoplay ("Spela"/hero/detail/continue) now selects the playable file exactly like the manual sidebar PLAY: when no filename matches the episode it falls back to the torrent's video file instead of skipping the source. This is why "Spela" failed on the very streams the sidebar plays fine. Play now uses the sidebar's stream list and plays regardless of whether torrentio (or any single scraper) is down.

## 1.0.22

- Autoplay now waits for a source that is still caching on the debrid (status 'downloading') instead of giving up on it, so "Spela" plays sources that are seconds from ready rather than bouncing back. Combined with 1.0.21's delegation, a play button plays whenever any sidebar stream is (or becomes) playable.

## 1.0.21

- Autoplay ("Spela" and all play buttons) now plays a stream whenever one exists in the sidebar. Previously it only started sources already cached on your debrid and gave up (bouncing you out) when a scraper like torrentio was down or a source wasn't pre-cached. It now delegates to the same add-and-wait flow the manual sidebar PLAY uses, independent of which scraper is up.

## 1.0.20

- Playback no longer drops you out of the detail view (to the home page) when a source fails to resolve: an empty player session is never opened — the stream sidebar stays open so you can pick a source.
- Episode file selection falls back to the single video file when a torrent's filename lacks a standard SxxExx tag (single-episode releases no longer bounce with no playback).

## 1.0.15

- Stream search now retries once after 1.5 s when the first attempt returns zero streams. Real-Debrid / scraper caches occasionally return empty mid-refresh; a single retry usually picks up the populated result without making the user navigate back+forward.
- Cleaned up outro-debug logging.

## 1.0.14

- Time-remaining next-episode popup now appears even when stream preload finds zero candidates. `pendingCardInfo` is set up front (after episode metadata is resolved) so the card renders regardless of stream resolution outcome; the "Play now" button stays disabled until streams are ready, with a manual fallback via `allowManualPlayWhenNotReady`.

## 1.0.13

- Wires IntroDB outro detection into the next-episode card so the popup appears at the outro mark and force-overrides the auto-play-next-episode setting (the setting now only gates the 5.2 s autoplay timer, not whether the card shows).
- Adds `prepareNextEpisodeCardInfo` so the card can render with metadata even before stream resolution finishes.
- Dismissing the next-episode card now cancels the pending autoplay timer.

## 1.0.11

- Fixes mobile/LAN details download button to render as true icon-only control (no lingering "Ladda ner" text).
- Aligns mobile header action circles (download, close, menu) for consistent sizing and spacing.

## 1.0.10

- Aligns with hard cutover to neutral stream-provider API routes (no /api/plugins/streams-scraper aliases).
- Syncs runtime with latest in-app stream-provider runtime implementation.

## 1.0.9

- Moves the runtime to a self-contained plugin implementation instead of relying on Moviefinder's internal `lib/plugins/streams-scraper/*` imports.
- Adds instant-play and stream-availability provider registrations in the external runtime.
- Updates desktop Real-Debrid API fallback to SDK-safe desktop command execution for external bundling.

## 1.0.8

- Publishes a freshly minified runtime bundle for lower plugin-cache footprint.
- Keeps full stream-provider/sidebar/playback contract behavior from 1.0.7.

## 1.0.7

- Restores full stream-provider registration in external runtime (same sidebar contract and play flow as baseline).
- Reuses the established Lumio stream sidebar/settings/playback components to avoid UI and behavior regressions.

## 1.0.6

- Rollback release: restores stable pre-separation baseline behavior.
- Keeps update path above 1.0.5 so clients can upgrade cleanly.

## 1.0.0

- Initial scraper plugin source metadata
- Added plugin documentation and marketplace entry
