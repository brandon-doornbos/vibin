import * as ChildProcess from 'child_process';
import * as DiscordVoice from '@discordjs/voice';

export class Track {
    url: string;
    title: string;
    length: number;

    constructor(url: string, title: string, length: number) {
        this.url = url;
        this.title = title;
        this.length = length;
    }

    create_audio_resource(): Promise<DiscordVoice.AudioResource> {
        return new Promise((resolve, reject) => {
            let process = ChildProcess.spawn('yt-dlp', [
                '--output', '-',
                '--quiet',
                '--format', 'bestaudio',
                '--rate-limit', '100K',
                '--no-cache-dir',
                '--no-call-home',
                this.url
            ], { stdio: [0, 'pipe', 0] });

            if (!process.stdout) {
                reject(new Error('No stdout'));
                return;
            }
            let stream = process.stdout;

            const onError = (error: Error) => {
                if (!process.killed) process.kill();
                stream.resume();
                reject(error);
            };

            DiscordVoice.demuxProbe(stream)
                .then((probe) => resolve(DiscordVoice.createAudioResource(probe.stream, { metadata: this, inputType: probe.type })))
                .catch(onError);
        });
    }
}
