# Media+

A Chrome extension to control the media playing in your browser, from one popup: volume boost, equalizer with presets, loop, MP4 / MP3 download (with yt-dlp), frame capture and the media's real source.

> Educational project, shared for code inspection. Respect the sites' terms and the creators: only download what you're allowed to keep. See [Notes](#notes).

## Features

**Media** (videos and sounds of the current tab, iframes and shadow DOM included, hidden preview players left out)
- Play / pause, seek, speed from 0.25× to 3×, loop and A-B loop
- One volume slider: 100 % in the middle is the site's normal volume, the left half lowers the media, the right half boosts the tab
- **Download**: video MP4 or audio MP3, whole or an extract (from / to, or the A-B loop)
  - direct files are saved by Chrome right away
  - streamed media (YouTube, Twitch, X…), MP3 and extracts go through [yt-dlp](#yt-dlp-companion), then Chrome's download manager
  - without the companion, the media is recorded while it plays (MP4, or M4A for audio)
- Frame capture at the video's full resolution (PNG, JPEG or WebP), downloaded and/or copied. Videos protected by the site are cropped from a capture of the tab
- Open the source in a new tab: the file itself, or the CDN stream / manifest behind a `blob:` URL
- Picture-in-picture
- Other tabs playing sound: pause, mute, jump to them, mute all

**Mixer** (whole tab)
- Volume boost up to 600 %
- 8-band equalizer (60 Hz → 15 kHz, ±14 dB) with a live spectrum; the curve goes exactly through the slider values and can be dragged
- Presets: Flat, Bass, Bass+, Harman, Voice, Movie, Music, Clarity, PC speakers, Night, plus your own
- Effects: bass enhancer, normalizer, karaoke / voice only (spectral), pitch without changing the speed
- Lowest band as a shelf (even lift) or a bell (punch at 70 Hz, sub rumble cut, bass band compressed on its own)
- Anti-distortion (headroom + look-ahead limiter), night mode (evens out quiet and loud parts), mono, balance
- Settings remembered per site or everywhere, applied when you open Media+ on the tab

**Settings**
- Download location: ask every time (the dialog opens in the last folder you used) or straight to Downloads, with an optional subfolder
- File names: media title or site + date; extracts get their time range
- yt-dlp: video quality (best or H.264 for compatibility), maximum resolution, use the site's login
- Capture format, default speed, keep the pitch, maximum boost, theme

**Shortcuts & context menu**
- Alt+Shift+M opens Media+, Alt+Shift+S captures, Alt+Shift+L loops, Alt+Shift+D downloads the media on screen (change them in `chrome://extensions/shortcuts`)
- Right-click a video or a sound: download, capture, loop, open the source
- English and French

## Install

1. Download this repository (Code → Download ZIP) and unzip it, or get the zip from the latest release
2. Open `chrome://extensions` and turn on **Developer mode**
3. Click **Load unpacked** and pick the folder

To update, replace the folder and click the reload icon on the extension.

## yt-dlp companion

Chrome extensions can't run programs, so yt-dlp needs a small companion that Chrome talks to ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)). Windows only for now.

1. Double-click `host\install.cmd` (or run `powershell -ExecutionPolicy Bypass -File host\install.ps1`)
2. Reopen the Media+ popup: **Settings → yt-dlp** shows the versions found

The script installs yt-dlp and ffmpeg with winget if they're missing, builds the companion with the C# compiler that comes with Windows (no download), and registers it for Chrome, Edge, Brave and Chromium for your user only (no admin rights). Everything lives in `%LOCALAPPDATA%\MediaPlus`; `host\uninstall.ps1` removes it.

How a download goes: yt-dlp saves the file in a temporary folder, the companion hands it to Chrome over `127.0.0.1` (random port and token, this file only), Chrome saves it like any download, then the temporary file is deleted. Keep yt-dlp up to date (`winget upgrade yt-dlp.yt-dlp`): sites change often.

## How it works

- `content.js` sits idle in every frame. It only notes which media URLs the page loads (Resource Timing, no network interception) and answers when the popup, a shortcut or the context menu asks.
- The popup talks to the exact frame that holds a media through `chrome.scripting`, and polls once per second only while it is open.
- The mixer captures the tab's sound (`chrome.tabCapture`) and runs it through Web Audio in an offscreen document. Nothing runs while the mixer is flat: the capture stops and the offscreen document closes as soon as no tab uses it. The spectrum is only read while the mixer is on screen.
- The companion only runs while a download is in progress.
- Manifest V3, ES modules, no dependencies, no build step, no server, no tracking.

## Notes

- Not affiliated with any website. DRM-protected media (Netflix, Disney+…) can't be downloaded, recorded or captured.
- The mixer works on the whole tab and Chrome shows a sharing icon on the tab while it's on. Chrome only allows it after a click on the extension (or its shortcut), which is why remembered settings are applied when you open the popup, not on their own.
- A recording plays in real time; its length is the time it played.
- "Use the site's login" writes that site's cookies to a temporary file for yt-dlp, deleted when the download ends.
- Pages of Chrome itself and the Web Store can't be accessed by extensions.

## License

[MIT](LICENSE)
