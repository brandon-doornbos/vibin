import * as ChildProcess from 'child_process';
import * as Discord from 'discord.js';
import * as DiscordVoice from '@discordjs/voice';

export class Track {
    url: string;
    title: string;
    length: number;
    now_playing_messages: Array<Promise<Discord.Message>>;

    constructor(url: string, title: string, length: number) {
        this.url = url;
        this.title = title;
        this.length = length;
        this.now_playing_messages = [];
    }

    on_start(channel: Discord.TextChannel) {
        const embed = new Discord.MessageEmbed()
            .setColor('#0099FF')
            .addField('Now playing', this.title);

        this.now_playing_messages.push(channel.send({ embeds: [embed] }));
    }

    on_finish() {
        for (let message of this.now_playing_messages) {
            message.then((handle: Discord.Message) => handle.delete());
        }
    }

    on_error(error: Error, channel: Discord.TextChannel) {
        console.warn(error);

        const embed = new Discord.MessageEmbed()
            .setColor('#FF0000')
            .addField('Error', error.message);

        channel.send({ embeds: [embed] }).then((handle: Discord.Message) => {
            setTimeout(() => handle.delete(), 30000);
        });
    }

    create_audio_resource(): Promise<DiscordVoice.AudioResource> {
        // return new Promise((resolve, reject) => {
        //     const stream = ytdl(this.url, { quality: 'highestaudio', filter: 'audioonly' });
        //     const onError = (error) => {
        //         stream.resume();
        //         reject(error);
        //     };
        //     demuxProbe(stream)
        //         .then((probe) => resolve(createAudioResource(probe.stream, { metadata: this, inputType: probe.type })))
        //         .catch(onError);
        // });
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
            // process
            //     .once('spawn', () => {
            //         demuxProbe(stream)
            //             .then((probe) => resolve(createAudioResource(probe.stream, { metadata: this, inputType: probe.type })))
            //             .catch(onError);
            //     })
            //     .catch(onError);
        });
    }
}
