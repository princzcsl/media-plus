# Changelog

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
