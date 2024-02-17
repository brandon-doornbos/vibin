# Vibin
Just a simple Discord music bot, able to stream from YouTube, YouTube Music and Spotify.

## Installing and Running
**Make sure you have ffmpeg and yt-dlp installed and in your PATH**

- Rename `src/config.json.example` to `src/config.json` and enter your token.
- Bun
    - `bun i`
    - `bun x tsc`
    - `node .`
    - *(Since bun does not yet have dgram support, see [this issue](https://github.com/oven-sh/bun/issues/1630), we can not run it directly. Otherwise we could change the main file to `src/bot.ts` and just do `bun .` without the transpile step or using Node.)*
- NodeJS
    - `npm i`
    - `npx tsc`
    - `node .`
