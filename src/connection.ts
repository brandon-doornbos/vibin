import * as FS from "fs";
import * as Discord from "discord.js";
import * as DiscordVoice from "@discordjs/voice";

import { Track } from "./track.js";
import { validateID } from "ytpl";
import { validateURL, getInfo } from "ytdl-core";
import { getFilters } from "ytsr";
import { promisify } from "util";
const wait = promisify(setTimeout);

export interface Text {
    channel: Discord.Channel;
}

export interface Voice {
    channel: Discord.VoiceChannel;
    connection: DiscordVoice.VoiceConnection;
    player: DiscordVoice.AudioPlayer;
}

export class GuildConnection {
    text: Text;
    voice: Voice;

    constructor(
        text_channel: Discord.Channel,
        voice_channel: Discord.VoiceChannel,
        voice_connection: DiscordVoice.VoiceConnection
    ) {
        this.text = { channel: text_channel };
        this.voice = {
            channel: voice_channel,
            connection: voice_connection,
            player: DiscordVoice.createAudioPlayer()
        };
        this.queue = [];
        this.activeQueueMessage = undefined;
        this.queueLock = false;
        this.readyLock = false;
        this.destroyed = false;

        this.prefix = '$';
        let prefix = undefined;
        try {
            prefix = FS.readFileSync(`db/prefixes/${this.clientId}/${this.text_channel.guild?.id}`, "utf8");
        } catch { }
        if (prefix) {
            this.prefix = prefix.trim();
        }

        this.voice_connection.on("stateChange", async (_, newState) => {
            switch (newState.status) {
                case voice_connectionStatus.Disconnected: {
                    if (newState.reason === voice_connectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
                        /*
                            If the WebSocket closed with a 4014 code, this means that we should not manually attempt to reconnect,
                            but there is a chance the connection will recover itself if the reason of the disconnect was due to
                            switching voice channels. This is also the same code for the bot being kicked from the voice channel,
                            so we allow 5 seconds to figure out which scenario it is. If the bot has been kicked, we should destroy
                            the voice connection.
                        */
                        try { // Probably moved voice channel
                            await entersState(this.voice_connection, voice_connectionStatus.Connecting, 5_000);
                        } catch { // Probably removed from voice channel
                            this.voice_connection.destroy();
                            this.text_channel.send("y u kick :(");
                        }
                    } else if (this.voice_connection.rejoinAttempts < 5) { // recoverable case with < 5 attemps, reconnect
                        await wait((this.voice_connection.rejoinAttempts + 1) * 5_000);
                        this.voice_connection.rejoin();
                    } else { // may be recoverable but > 5 attemps, destroy
                        this.voice_connection.destroy();
                    }
                    break;
                }
                case voice_connectionStatus.Destroyed: {
                    this.stop();
                    this.destroyed = true;
                    break;
                }
                case voice_connectionStatus.Connecting: case voice_connectionStatus.Signalling: {
                    if (this.readyLock) break;
                    /*
                        In the Signalling or Connecting states, we set a 20 second time limit for the connection to become ready
                        before destroying the voice connection. This stops the voice connection permanently existing in one of these
                        states.
                    */
                    this.readyLock = true;
                    try {
                        await entersState(this.voice_connection, voice_connectionStatus.Ready, 20_000);
                    } catch {
                        if (this.voice_connection.state.status !== voice_connectionStatus.Destroyed) this.voice_connection.destroy();
                    } finally {
                        this.readyLock = false;
                    }
                    break;
                }
                case voice_connectionStatus.Ready: {
                    this.voice_channel = this.voice_connection.packets.state.channel_id;
                }
            }
        });

        this.audioPlayer.on("stateChange", (oldState, newState) => {
            if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) { // now idle, play next track if available
                oldState.resource.metadata.onFinish();
                void this.processQueue();
            } else if (newState.status === AudioPlayerStatus.Playing) { // entered playing state, started next track
                newState.resource.metadata.onStart(this.text_channel);
            }
        });

        this.audioPlayer.on("error", (error) => error.resource.metadata.onError(error, this.text_channel));

        voice_connection.subscribe(this.audioPlayer);
    }

    update_prefix(newPrefix) {
        this.prefix = newPrefix;
        try {
            accessSync(`db/prefixes/${this.clientId}`);
        } catch {
            mkdirSync(`db/prefixes/${this.clientId}`);
        }
        writeFileSync(`db/prefixes/${this.clientId}/${this.text_channel.guild?.id}`, this.prefix);
    }

    async play(message) {
        const url = message.content.slice(message.content.indexOf(" ") + 1);

        if (message.member.voice.channelId !== this.voice_channel) {
            await message.reply("Join the correct voice channel and then try that again!");
            console.log("plz join correct channel");
            return;
        }

        try {
            await entersState(this.voice_connection, voice_connectionStatus.Ready, 20e3);
        } catch (error) {
            console.warn(error);
            await message.reply("Failed to join voice channel within 20 seconds, please try again later!");
            return;
        }

        try {
            if (validateID(url)) {
                const playlist = await ytpl(url, { limit: Infinity });
                let duration = 0;
                for (let item of playlist.items) {
                    const track = new Track(item.shortUrl, item.title, item.durationSec);
                    this.enqueue(track);
                    duration += item.durationSec;
                }

                const embed = new MessageEmbed()
                    .setColor("#00FF00")
                    .setThumbnail(playlist.thumbnails[0].url)
                    .addField("Added playlist", `[${playlist.title}](${playlist.url})`)
                    .addField("Length", secondsToHms(duration), true)
                    .addField("Tracks", playlist.items.length.toString(), true);

                message.reply({ embeds: [embed] });
            } else if (validateURL(url)) {
                const info = await getInfo(url);
                const video = info.videoDetails;
                const track = new Track(url, video.title, video.lengthSeconds);
                this.enqueue(track);

                const embed = new MessageEmbed()
                    .setColor("#00FF00")
                    .setThumbnail(video.thumbnails[0].url)
                    .addField("Added track", `[${track.title}](${url})`)
                    .addField("Length", secondsToHms(video.lengthSeconds))

                message.reply({ embeds: [embed] });
            } else {
                const filters = await getFilters(url);
                const filter = filters.get("Type").get("Video");
                const results = await ytsr(filter.url, { limit: 1 });
                const firstResult = results.items[0];
                const info = await getInfo(firstResult.url);
                const video = info.videoDetails;
                const track = new Track(firstResult.url, firstResult.title, video.lengthSeconds);
                this.enqueue(track);

                const embed = new MessageEmbed()
                    .setColor("#00FF00")
                    .setThumbnail(video.thumbnails[0].url)
                    .addField("Added track", `[${track.title}](${firstResult.url})`)
                    .addField("Length", secondsToHms(video.lengthSeconds));

                message.reply({ embeds: [embed] });
            }
        } catch (error) {
            console.warn(error);
            this.text_channel.send("Failed to play track, please try again later!");
        }
    }

    enqueue(track) {
        this.queue.push(track);
        void this.processQueue();
    }

    stop() {
        this.queueLock = true;
        this.queue = [];
        this.audioPlayer.stop(true);
    }

    async processQueue() {
        if (this.queueLock || this.audioPlayer.state.status !== AudioPlayerStatus.Idle || this.queue.length === 0)
            return;

        this.queueLock = true;

        const nextTrack = this.queue.shift();
        try {
            // Attempt to convert the Track into an AudioResource (i.e. start streaming the video)
            const resource = await nextTrack.createAudioResource();
            this.audioPlayer.play(resource);
            this.queueLock = false;
        } catch (error) {
            // If an error occurred, try the next item of the queue instead
            nextTrack.onError(error, this.text_channel);
            this.queue.unshift(nextTrack);
            this.queueLock = false;
            return this.processQueue();
        }
    }
}
