# Changelog

## 1.7.0
- When yt-dlp can't read a page (site changed, request refused…), the download is tried again with the stream the player itself loaded (MP4 or HLS playlist)
- yt-dlp is told which page the media comes from (referer), which some video hosts require
- Settings: the yt-dlp version shows its age with a warning past 45 days, and an "Update" button updates it (yt-dlp -U, winget as plan B)
- Run `host/install.cmd` again for this version

## 1.6.1
- The mixer switch is remembered per site, and the mixer is off on a site it has never been turned on for. A tab already being processed keeps going until its own switch is turned off

## 1.6.0
- Download "Advanced options": maximum resolution and video codec for this download (best available, H.264 for editing software, VP9, AV1); the defaults are in the settings, where the codec replaces the old quality choice
- The extension now builds the yt-dlp format choice and the companion only relays it: future format changes won't need a reinstall. Run `host/install.cmd` once more for this version
- The mixer switch is per tab: turning it off on one tab leaves the others running

## 1.5.1
- A download that needs yt-dlp no longer starts a recording on its own: it says why (companion unreachable, or turned off) and offers to record the media while it plays
- A recording shows a bar with its time, "Stop and save" and "Cancel" (nothing is kept)
- Settings: the yt-dlp status shows Chrome's exact error and the extension ID, and "Check" is always there

## 1.5.0
- Timeline drawn with transforms: it glides by fractions of a pixel instead of moving pixel by pixel
- The media volume is the tab's volume on top of the site's player: 100 % is always the site's sound untouched, it no longer follows the site's own slider (51 %…), and a new tab starts at 100 %
- Switch at the top of the popup to turn the whole mixer on or off, settings kept
- Every mixer setting is remembered (enhancer, effects, bell…) except the volume, saved right away; remembered everywhere by default
- The bell of the lowest band can be tuned: centre (35-150 Hz) and width

## 1.4.0
- The yt-dlp companion answers its status check at once (a cold yt-dlp could take seconds and look "not installed"); the settings say why when it isn't found. Run `host/install.cmd` again to update it
- Tabs opened before an update get the new page agent automatically, and the timeline never steps back
- Bass: a button under the 60 Hz band switches its shape between shelf and bell; the bell is wider and gentler
- Presets: Harman added (shelf), Bass and Bass+ use the bell; the VLC trial presets are gone
- No default download subfolder

## 1.3.1
- Timeline: positions are time-stamped and small differences eased in, so it no longer steps back at each refresh
- Weaker magnet on the volume slider
- Beta bass: wider, gentler bell
- Bass presets to try: Harman headphone target and VLC presets (Full Bass, Dance, Techno, Party, Large Hall, Bass & Treble)

## 1.3.0
- Timeline glides between updates instead of jumping every second
- Volume slider: a magnet catches 100 % from a few percent away
- Voice: new spectral separation (left and right compared frequency by frequency), panned instruments keep their stereo, kick, bass and cymbals stay in karaoke
- Beta bass engine to compare with the classic one: bell at 70 Hz instead of a shelf, rumble under 25 Hz cut, bass band compressed on its own, warmer harmonics for the bass enhancer

## 1.2.0
- Equalizer: the curve now goes exactly through every slider value (the filter gains are solved for it), range ±14 dB
- New look-ahead limiter: it doesn't touch the sound until it would clip, so heavy bass (rap…) no longer pumps
- Effects: bass enhancer, normalizer (same loudness from one video to the next), karaoke / voice only, pitch without changing the speed
- Media volume: 100 % is the middle of the slider (the site's normal volume), beyond it boosts the tab, double-click to reset
- Thumbnails from the site's artwork (YouTube…) and updated when a playlist moves on
- More room in the media cards, "Show on the page" removed, active buttons turn violet right away

## 1.1.0
- New logo and a look closer to IG-Utils; the version moved to the bottom of the settings
- One "Download" button: video MP4 or audio MP3, whole or an extract, with yt-dlp through a small Windows companion (`host/install.cmd`), recording as a fallback
- yt-dlp downloads show their progress in the popup and end in Chrome's download manager; quality, maximum resolution and site login settings
- Hidden players (hover previews, preloaded videos) no longer show up as media
- The media volume slider goes past 100 % by driving the mixer's boost
- Mixer: 8 bands up to ±18 dB, handles on the curve, live spectrum, new presets (Bass, Bass+, Voice, Movie, Music, Clarity, PC speakers, Night), automatic headroom so bass boosts don't pump, night mode, mono rebuilt, balance value with a snap to the center
- Mixer settings remembered per site or everywhere
- The extension ID no longer depends on the folder it's loaded from

## 1.0.0
- First version: media list with playback controls, speed, loop and A-B loop
- Download (direct, blob, or real-time MP4 recording of streamed media), frame capture, open the source, picture-in-picture
- Mixer: volume boost up to 600 %, 10-band equalizer with presets and custom presets, limiter, mono, balance
- Other tabs playing sound, keyboard shortcuts, context menu, settings, English and French
