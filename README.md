# Media+

A Chrome extension to control the media playing in your browser, from one popup: volume boost, equalizer with presets, loop, MP4 download, frame capture and the media's real source.

> Educational project, shared for code inspection. Respect the sites' terms and the creators: only download what you're allowed to keep. See [Notes](#notes).

## Features

**Media** (videos and sounds of the current tab, iframes and shadow DOM included)
- Play / pause, seek, volume, mute, speed from 0.25× to 3×
- Loop, and A-B loop on a segment
- Download: direct files go through Chrome's download manager, blob files too
- Streamed media (MSE: YouTube, Twitch, X…): record it while it plays as MP4, or take one of the streams the player loaded from its CDN
- Frame capture at the video's full resolution (PNG, JPEG or WebP), downloaded and/or copied to the clipboard. Videos protected by the site are cropped from a capture of the tab
- Open the source in a new tab: the file itself, or the CDN stream / manifest behind a `blob:` URL
- Picture-in-picture, scroll to the media on the page
- Other tabs playing sound: pause, mute, jump to them, mute all

**Mixer** (whole tab)
- Volume boost up to 600 %
- 10-band equalizer (32 Hz → 16 kHz, ±12 dB) with a live response curve you can drag
- Presets: Flat, Bass+, Bass max, Treble+, Voice, Movie, Music, FPS, Night, plus your own
- Limiter against distortion, mono, left / right balance

**Settings**
- Download location: ask every time (the save dialog opens in the last folder you used) or straight to the Downloads folder, with an optional subfolder
- File names: media title or site + date
- Capture format and what happens after a capture
- Default speed for every media, keep the pitch when sped up
- Maximum boost, theme (system, dark, light)

**Shortcuts & context menu**
- Alt+Shift+M opens Media+, Alt+Shift+S captures, Alt+Shift+L loops, Alt+Shift+D downloads the media on screen (change them in `chrome://extensions/shortcuts`)
- Right-click a video or a sound: download, capture, loop, open the source
- English and French

## Install

1. Download this repository (Code → Download ZIP) and unzip it, or get the zip from the latest release
2. Open `chrome://extensions` and turn on **Developer mode**
3. Click **Load unpacked** and pick the folder

To update, replace the folder and click the reload icon on the extension.

## How it works

- `content.js` sits idle in every frame. It only watches which media URLs the page loads (Resource Timing, no network interception) and answers when the popup, a shortcut or the context menu asks.
- The popup talks to the exact frame that holds a media through `chrome.scripting`, and polls once per second only while it is open.
- The mixer captures the tab's sound (`chrome.tabCapture`) and runs it through Web Audio in an offscreen document. Nothing runs while the mixer is flat: the capture stops and the offscreen document is closed as soon as no tab uses it.
- Manifest V3, ES modules, no dependencies, no build step, no server, no tracking.

## Notes

- Not affiliated with any website. DRM-protected media (Netflix, Disney+…) can't be downloaded, recorded or captured.
- The mixer works on the whole tab, and Chrome shows a sharing icon on the tab while it's on. It has to be turned on from the popup (Chrome only allows a tab capture after a click on the extension), and stays on across reloads of that tab until you set it back to flat or close the tab.
- A recording plays in real time; its length is the time it played.
- Pages of Chrome itself and the Web Store can't be accessed by extensions.

## License

[MIT](LICENSE)
