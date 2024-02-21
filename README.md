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

## Spotify support for playlists larger than 100
Spotify does not allow access to playlists larger than 100 items without the use of their Web API. So if you want support for that you need to follow steps 1 and 2 from the *Getting Started* section on [this page](https://developer.spotify.com/documentation/web-api). After which you need to paste the client id and client secret in your `src/config.json`.

If you do not want this hassle or support, just leave both entries empty.
