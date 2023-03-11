import * as ChildProcess from "child_process";
import * as DiscordVoice from "@discordjs/voice";

export class Track {
    url: string;
    title: string;
    length: number;
    start_time: number;
    process: null | ChildProcess.ChildProcess;

    constructor(url: string, title: string, length: number) {
        this.url = url;
        this.title = title;
        this.length = length;
        this.start_time = 0;
        this.process = null;
    }

    create_audio_resource(timestamp = 0): Promise<DiscordVoice.AudioResource> {
        return new Promise((resolve, reject) => {
            this.process = ChildProcess.spawn("yt-dlp", [
                "--output", "-",
                "--quiet",
                "--format", "bestaudio",
                "--no-check-certificates",
                "--prefer-free-formats",
                "--extractor-args", "youtube:skip=dash",
                "--rate-limit", "100K",
                "--no-cache-dir",
                "--no-call-home",
                "--download-sections", "*" + timestamp + "-inf",
                "--downloader", "ffmpeg",
                "--external-downloader-args", "ffmpeg_i:-reconnect 1",
                "--",
                this.url
            ], { stdio: [0, "pipe", 0] });

            if (!this.process.stdout) {
                reject(new Error("No stdout"));
                return;
            }
            const stream = this.process.stdout;

            const onError = (error: Error) => {
                if (!this.process?.killed)
                    this.destroy();
                stream.resume();
                reject(error);
            };

            DiscordVoice.demuxProbe(stream)
                .then((probe) => resolve(DiscordVoice.createAudioResource(probe.stream, { metadata: this, inputType: probe.type })))
                .catch(onError);
        });
    }

    destroy() {
        this.process?.kill();
    }
}
