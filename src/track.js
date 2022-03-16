import { spawn } from 'child_process';
import { MessageEmbed } from 'discord.js';
import {
    createAudioResource,
    demuxProbe,
} from '@discordjs/voice';
// import ytdl from 'ytdl-core';

export class Track {
    constructor(url, title, length) {
        this.url = url;
        this.title = title;
        this.length = length;
        this.nowPlayingMessages = [];
    }

    onStart(channel) {
        const embed = new MessageEmbed()
            .setColor('#0099FF')
            .addField('Now playing', this.title);

        this.nowPlayingMessages.push(channel.send({ embeds: [embed] }));
    }

    onFinish() {
        for (let message of this.nowPlayingMessages) {
            message.then((handle) => handle.delete());
        }
    }

    onError(error, channel) {
        console.warn(error);

        const embed = new MessageEmbed()
            .setColor('#FF0000')
            .addField('Error', error.message);

        channel.send({ embeds: [embed] }).then((handle) => {
            setTimeout(() => handle.delete(), 30000);
        });
    }

    createAudioResource() {
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
            let process = spawn('yt-dlp', [
                '-o',
                '-',
                '-q',
                '-f', 'bestaudio',
                '-r', '100K',
                '--no-cache-dir',
                this.url
            ], {
                detached: true,
                stdio: [0, 'pipe', 0]
            });

            if (!process.stdout) {
                reject(new Error('No stdout'));
                return;
            }
            let stream = process.stdout;

            const onError = (error) => {
                if (!process.killed) process.kill();
                stream.resume();
                reject(error);
            };

            demuxProbe(stream)
                .then((probe) => resolve(createAudioResource(probe.stream, { metadata: this, inputType: probe.type })))
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
