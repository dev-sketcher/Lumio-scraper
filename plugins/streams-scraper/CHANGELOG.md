# Changelog

## 1.0.147

- Snabbare start utan att byta ström: klickar du på en ocachad rad och SAMMA fil
  (samma infoHash och fileIdx) finns cachad hos en annan källa spelas den cachade
  länken — samma innehåll bit för bit, bara utan debridens hämtning. Genvägen
  som togs bort i 1.0.146 bytte till en annan release; det här kan den inte.
- Källcachen förvärms för raden pekaren landar på (200 ms), så debridens första
  byte för en direkt länk börjar medan du fortfarande läser raden. Aldrig i
  klientsession, en i taget.

## 1.0.146

- Den ström du KLICKAR på är den som spelas. En genväg bytte tyst ut en ocachad
  träff mot den högst rankade cachade i listan — därför spelade varje ocachad
  rad samma länk (första träffen från en annan källa), och när den källans
  cachade flagga ljög fick man debridens "laddar ner"-platshållare. "Öppna
  externt" gav rätt länk eftersom den vägen inte passerade genvägen.

## 1.0.140

- Telemetri för felsökning av "fel fil under rätt titel": uppspelningshändelserna
  bär nu källans värdnamn, en hash av ström-URL:en (aldrig själva länken) och
  strömmens filnamn/titel, så det går att se om två uppslag fick samma länk.

## 1.0.139

- Safari/iPhone (fjärr): en lång källrubrik över strömlistan gjorde raderna
  bredare än vyn så de försvann ut till höger. Rubriken klipps nu med
  ellips (min-w-0 på flex-barnet) i stället för att trycka ut bredden.

## 1.0.138

- Inline under avsnittet visar sektionen aldrig sina egna säsongs- och
  avsnittsvyer — panelen äger dem. Vid avsnittsbyte blinkade "← Säsong" och
  avsnittslistan fram en sekund medan avsnitten laddades; nu en lugn snurra.

## 1.0.137

- När strömlistan ligger inline under avsnittet (detaljsidans layoutval) döljs
  sektionens egen brödsmula "← Säsong / E01": säsong och avsnitt står redan i
  panelen ovanför. Kräver app med `inlineLayout`-propen; äldre appar visar
  brödsmulan som förut.

## 1.0.136

- Serier: källväljaren ligger nu på strömlistans rubrikrad (etikett vänster,
  väljare höger) i stället för på brödsmuleraden — samma 8 px ner till första
  strömmen som för film.

## 1.0.135

- Källväljaren syns så fort den första källan svarat, inte först när det finns
  två; källor som fortfarande söker står med i rullistan med egen snurra.
- Mindre knapp, och för film ligger den som första rad i strömlistan så
  avståndet ner till första strömmen är samma som mellan två strömmar.

## 1.0.134

- Källfiltret är en rullista bakom en hamburgare uppe till höger i stället för
  en chiprad över listan: på brödsmuleraden för serier (bredvid avsnittet), i
  listans övre högra hörn för film. Grupprubrikerna per källa är kvar när
  "Alla källor" är valt.

## 1.0.133

- HOTFIX: 1.0.132 kraschade klienten ("Can't find variable: t") så fort
  strömlistan med källchips renderades — `StreamList` använde `t()` utan att
  hämta det via `useLang()`. Samma fel (TS2304, namn som inte finns) fanns i
  nedladdningen av flerfilspaket (`VIDEO_EXTS`). Båda lagade, och byggets
  typkontrollgrind fäller nu även TS2304.

## 1.0.132

- Strömsökningen frågar alla källor samtidigt och visar varje källas rader så
  fort den svarar. Tidigare kördes en native-batch först och den väntade på den
  långsammaste källan (3 s × 2 försök) innan AIOStreams, Jackettio och
  community-addons ens fick sin första förfrågan — median 3,1 s, p75 7,4 s i
  telemetrin, och samma titel kunde ta 0,8 s eller 28 s.
- Färre förfrågningar mot källorna, inte fler: en förfrågan per väg, nästa väg
  bara vid nätfel, ett tomt svar frågas aldrig om, rate-limit ger vila utan
  nytt försök, och den gamla omkörningen av ALLA källor vid tomt resultat är
  borta. Aggregatorerna får aldrig mer än en förfrågan per sökning.
- Community-addons har nu en budget (12 s) och publiceras var för sig; en addon
  som hängde (uppmätt 25 s) höll tidigare tillbaka hela listan.
- Under listan syns vilka källor som fortfarande söker och vilka som inte
  svarade, så en tidig, delvis lista inte ser färdig ut.
- Telemetrin för `streams.lookup` bär nu total tid, tid till första rader och
  tid/utfall/väg per källa.
- "DV HDR"-strömmar (Dolby Vision profil 8, med HDR10-baslager) märks inte
  längre som inkompatibla på enheter utan DV-avkodare — de spelas som HDR10.
  Bara profil 5 (ensamt "DV") märks. "Atmos" ensamt räknas inte längre som
  förlustfritt ljud: på WEB-DL är det E-AC-3, som alla enheter avkodar.

## 1.0.120

- Avsnittslistan i spelaren fanns bara om man BLÄDDRAT i säsongslistan först.
  Startade man avsnittet från Fortsätt titta, ett nästa-avsnitt-hopp eller
  hero-knappen fick spelaren ingen lista, fast pluginet visste både serie och
  säsong — knappen ritades därför inte, utan att något såg trasigt ut. Läst av i
  den körande appen på telefonen: spelarens titel sa "S01E04" medan listan var
  tom.
- Listan hämtas nu efter det som SPELAS, inte efter vad panelen råkar visa, och
  utan att nollställa strömlistan eller valt avsnitt på vägen. Cachen delas, så
  en bläddring efteråt kostar ingen ny hämtning.

## 1.0.119

- Avsnittslistan och Nästa avsnitt föll bort tyst på serier med många säsonger.
  Panelens nollställningseffekt kördes också vid montering — efter effekten som
  startar hämtningarna — så panelen avbröt sina egna första anrop med
  `AbortError`. Säsongerna räddades av en retry; avsnittslistan hade ingen och
  sattes till tom för gott, och då finns det inget att ge spelaren och knappen
  ritas inte. Bekräftat i enhetsloggen (`loadSeasons misslyckades: AbortError`)
  på en tjugo säsonger lång serie, där svaret är tungt nog att förlora
  kapplöpningen.
- Nollställningen gäller nu bara ett riktigt titelbyte, inte monteringen.
- Både säsongs- och avsnittshämtningen gör om försöket vid abort, med växande
  paus (300/700/1500 ms) i stället för en fast på 400 ms, och varje misslyckat
  försök loggas med sitt nummer — så nästa gång syns det om det var ett eller
  alla tre.

## 1.0.118

- Spelaren är ombyggd i appen (nytt kontrollager för desktop och telefon), och
  pluginet bundlar sin egen kopia av den. Den här releasen finns för att hämta
  in kopian: utan den kör strömuppspelning kvar på den gamla spelaren medan
  appens egna vägar visar den nya, alltså två olika spelare i samma app.
- Avsnittslistan och Nästa avsnitt bär därmed den nya designen i
  strömuppspelning: knappen i kontrollradens vänstra zon på desktop, som
  bricka respektive piller på telefon.
- Ingen ändring i scraper-logiken, ingen ändring i strömvalet.

## 1.0.114

- Every stream row in the panel has a download button, next to Play. Series had
  no working way to download a specific episode at all: clicking an episode
  opens this panel, and downloading lived on the details page — which had to
  guess which episode was meant and run its own stream search. The panel already
  holds both decisions, so the choice now finishes where it is made.
- A stream that needs debrid says so before the click instead of failing after
  it, and every download failure is written to the debug log with whether the
  stream had a direct URL and whether a key was present.
- The download logic moved to a shared module so the details button and the
  panel rows cannot drift apart.

## 1.0.113

- A failed IMDb lookup no longer claims the title has no IMDb id. The lookup ran
  with a 4.2 s timeout, swallowed every error and never retried, so one slow or
  dropped request left the panel stuck on "No IMDb ID — use manual input below"
  — a statement about the title when the truth was that no answer arrived. It
  now waits 12 s, retries once, and says it could not reach the metadata service
  when that is what happened.

## 1.0.112

- The streams panel really searches when a community addon is the only source.
  1.0.111 opened the access gate but the search itself still returned early on
  an empty scraper list, so the panel said "No stream providers enabled" with a
  manifest installed. All four places that assumed streams can only come from a
  scraper — the access gate, the search's early return, the retry and the error
  state — now read one shared value instead of being fixed one at a time.

## 1.0.111

- The streams panel accepts a community addon as a playback source. It used to
  read only the scraper list, so an install whose single source was an
  AIOStreams manifest got "No scraper is enabled — nothing can find streams"
  and advice to turn on a scraper — the wrong advice, since such an addon hands
  out finished URLs without a scraper or a debrid key.
- Those addons are now queried alongside the scraper for every lookup, with
  season and episode, and their streams enter the same list as cached entries.

## 1.0.110

- Downloads work when the streams come from a community addon. The button used
  to throw "Debrid key missing" before it fetched any stream list, so an install
  whose only source was an AIOStreams manifest could not download at all — even
  though such addons hand out finished URLs that need no debrid at all. The key
  is now required only by the stream you actually pick, and only when it is a
  magnet that has to go through debrid.
- Stream-capable community addons are queried alongside the scraper, per title
  and per episode (`tt…:S:E`), and their results are merged into the same
  picker.
- The icon-only error state showed a bare "!" with the reason in `title`, which
  never appears on a touch screen. The first tap now reveals the reason, the
  second resets.

## 1.0.109

- The Scrapers card on the overview no longer claims "nothing can find streams"
  when a stream-capable community addon is installed. A manifest added under
  community catalogs lands in core stream storage and resolves streams without
  a scraper or a debrid key, so the card read only half the picture and showed a
  red state to someone who could play fine.

## 1.0.108

- Stream file size is shown for every stream, exactly once. The backend now
  carries `sizeBytes` (lifted from the addon's raw response before the clean
  filename replaces the metadata line), so size no longer depends on the
  release name happening to contain it — measured 4 of 50 streams before, 50 of
  50 after. Where the title already prints "💾 18.9 GB" the chip is dropped
  instead of repeating the number.
- An AIOStreams manifest saved in the scrapers menu now installs like one
  pasted under community catalogs: its catalogs become selectable row sources,
  and a stream-capable addon lands in core stream storage — which is what makes
  the manifest work on its own, without scraper or debrid fields filled in.
- Sizes are parsed from binary units (GiB/MiB) as well.
- Empty states in the stream sidebar follow the app language and give the right
  advice.

## 1.0.97

- Open in external player button on the Android app (Quest and phones): hands
  the stream URL to the system chooser so 4XVR/Skybox/DeoVR (Quest) or VLC/MX
  Player (phones) can play it natively. Requires app 0.1.38+.

## 1.0.96

- Copy stream URL button per stream row on desktop remote/LAN client browsers
  (paste into VLC → Open Network Stream). Field-agnostic direct-URL lookup:
  comet/torrentio streams often carry the http URL outside `directUrl`.
- Open in VLC per stream row on mobile clients (deep link), replacing the
  desktop-useless variant; the "always VLC" toggle stays mobile-only.
- The download picker becomes a full-width bottom sheet on narrow phones so
  it can no longer run off the left edge of the screen.
- Removes temporary debug logging.

## 1.0.81

- Removes the 1.0.80 diagnostic. The cause was outside this plugin: the app's
  localStorage had filled to its per-origin cap, so creating a new key failed
  while rewriting an existing one still worked. Every profile-scoped setting
  is a new key the first time it is saved, and the failure was swallowed —
  the value reached the native mirror, so saving looked like it worked and
  the next read fell back to the default list. Fixed in the app.

## 1.0.80

- Diagnostic build: logs what writes the scraper list. Removed once fixed.

## 1.0.79

- Profile-scoped storage now goes through the host SDK instead of a copy
  bundled into this runtime, so the plugin can no longer end up on different
  profile logic than the app around it.

## 1.0.78

- Saving a scraper card no longer wipes the other scrapers. The card read the
  whole list and wrote it straight back, so whenever that read answered with
  the default list instead of the stored one, the default was saved over
  everything. Edits already persist through the list itself.

## 1.0.76

- A profile no longer reads the pre-profile scraper list. Removing a scraper
  was stored on the profile, but the list shown afterwards could fall through
  to the older copy, so the removed entry looked like it came back.

## 1.0.75

- Editing scrapers on a profile sticks. Reading the list could copy the
  pre-profile list over the profile's own, so a removed scraper reappeared a
  moment later.

## 1.0.73

- Rebuilt against the host's corrected profile scoping. The runtime embeds
  its own copy of that code, so settings edited here resolved their storage
  namespace differently from the rest of the app.

## 1.0.71 – 1.0.72, 1.0.74, 1.0.77

- Diagnostic builds used to trace the disappearing scraper list, plus their
  removal. No behaviour of their own.

## 1.0.70

- Adding a scraper sticks. The settings list rebuilt itself from a snapshot
  taken before the addition whenever a card reported a change from its own
  async loading, which lands seconds later and quietly wrote the shorter
  list back over the new one.

## 1.0.69

- The download button on the details page follows the app language. It
  carried its own copy of the component, so it kept rendering Swedish
  labels and error text no matter which language was selected.

## 1.0.68

- Cancel on the next-episode card disarms everything: the parallel outro
  timer is gone (the card owns the countdown, and only when auto-play next
  is enabled), dismissed state blocks late pollers, and the splash cancel
  resets next-episode state. Fixes the episode that kept starting - even
  invisibly from the home screen - after pressing cancel.


## 1.0.67

- Android: streams that start to a black screen get an automatic forward
  nudge (the manual seek that unstuck them) after ~5s without progress.


## 1.0.66

- The window-fullscreen toggle is hidden on Android (the shell is already
  edge-to-edge; the native window API it calls is desktop-only).


## 1.0.65

- Silent audio on Comet streams: opaque playback URLs carry no codec
  markers, so the audio-transcode proxy never engaged for DDP/EAC3 tracks.
  The release filename from the stream title now drives that decision.


## 1.0.64

- Season loads aborted by the sidebar's own remount retry automatically -
  slow device networks lost that race and showed 'Could not load seasons'.


## 1.0.63

- Season load failures log their real cause to the debug log.


## 1.0.62

- Android autoplay prefers codecs the webview can decode: h264 first,
  8-bit HEVC next, 10-bit HEVC last (it starts and then dies to black).


## 1.0.61

- Series load on Android: the desktop API bridge threw when its command is
  absent (Android registers none) instead of falling back to plain HTTP -
  every season/episode fetch failed with 'Could not load seasons'.


## 1.0.60

- Settings dropdown panels get an opaque background (arbitrary Tailwind
  color values are not present in the host CSS at runtime — inline style).


## 1.0.59

- Scraper settings dropdowns replaced with plugin-native controls: the
  bundled HeroUI Select popover never opens across the plugin/host provider
  boundary. Multi-selects are hand-rolled panels, sort is a native select.


## 1.0.58

- Season/episode fetches get a 15s budget (was 4.5s) — cold TMDB round-trips
  on device networks made series show "Could not load seasons".


## 1.0.57

- Scraper settings dropdowns open above the settings overlay (they rendered
  behind it and looked dead).
- Quality/language/source/sort catalogs are fetched live from torrentio's
  configure page (24h server cache, static fallback) so the choices always
  match what torrentio actually accepts. The old hardcoded quality list
  contained tokens torrentio never supported ('ts', 'brisk') — exclusions
  now take effect for real. Re-pick source filters if you had any saved.

## 1.0.56

- Closing a direct-play session returns to a scrollable home screen: the
  details panel no longer parks hidden while holding the body scroll lock.
- Scroll-lock counter is shared through the DOM across host and plugin
  bundles.
- External player choice: macOS opens the configured app, Android fires a
  video intent (system app chooser, e.g. 4XVR).
- TorrentsDB removed as a default scraper; auto-added entries are cleaned up.

## 1.0.55

- Night mode: disable the limiter's auto-level, which renormalized the
  capped signal back to 0 dB and made every mode louder than off. Measured
  now: dialog untouched, peaks -4 dB (mild) / -8 dB (strong).

## 1.0.54

- Night mode curves reworked: peaks are tamed with no makeup gain, so
  Strong is the quietest setting and dialog stays at its normal level.

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
