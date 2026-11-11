# Win TV

My PC is across the room from my couch, so I made a small app that turns it into a TV box. You control it with a game controller or your phone. No keyboard needed.

I use it every day and it made watching stuff a lot easier, so I'm sharing it in case someone else finds it useful.

## What it does

- Your apps (YouTube, Netflix, Prime, ...) on one home screen
- Plays your own movies and music, remembers where you stopped
- Next episode starts by itself, plus subtitles and audio language switching
- Phone works as a remote, touchpad and keyboard
- Audio-only mode for music and podcasts
- Live TV from your own M3U channel list
- Wi-Fi, Bluetooth and speaker switching from the couch
- Apps stay open in the background, so going back doesn't reset them

## Download

Go to **[Releases](../../releases)**, download the zip, unzip it and run `TV.exe`.
Windows only. Nothing to install.

If Windows says "Windows protected your PC", click **More info → Run anyway** (the app isn't code-signed).

## Controller

| Button | Home / menus | Watching | Inside apps |
|---|---|---|---|
| D-pad / left stick | move | seek / volume | arrow keys |
| Right stick | | | mouse |
| X / A | select | pause | click |
| O / B | back | back | back |
| Triangle / Y | options | options | |
| Share / View | Control Center | audio only | Control Center over the app |
| PS / Start | Home | Home | Home (app stays open) |

PS4-style controllers work in Xbox mode. Keyboard works too.

## Build it yourself

```
npm install
npm start          # run
npm run build      # makes dist/win-unpacked/TV.exe
```

## License

MIT for this app. Bundled ffmpeg is GPL, see `THIRD-PARTY-NOTICES.txt`.
