import * as Discord from "discord.js";
import * as DiscordVoice from "@discordjs/voice";
import * as Util from "util";
import { default as YTPL } from "ytpl";
import { default as YTDL } from "ytdl-core";
import { default as YTSR } from "ytsr";
import { Bot } from "./bot.js";
import { Track } from "./track.js";
import { shuffle, seconds_to_hms, string_to_index } from "./utils.js";

const wait = Util.promisify(setTimeout);

export class AudioConnection {
    private text_channel: Discord.TextChannel;

    private voice_channel: Discord.VoiceChannel;
    voice_connection: DiscordVoice.VoiceConnection;

    private audio_player: DiscordVoice.AudioPlayer;

    private queue: Track[];
    private queue_lock: boolean;
    active_queue_message: Discord.Message | null;

    private now_playing_message: Discord.Message | null;

    private ready_lock: boolean;
    destroyed: boolean;

    constructor(voice_channel: Discord.VoiceChannel, text_channel: Discord.TextChannel) {
        this.text_channel = text_channel;

        this.voice_channel = voice_channel;
        this.voice_connection = DiscordVoice.joinVoiceChannel({
            channelId: this.voice_channel.id,
            guildId: this.voice_channel.guild.id,
            adapterCreator: this.voice_channel.guild.voiceAdapterCreator,
            selfDeaf: true
        });

        this.audio_player = DiscordVoice.createAudioPlayer();

        this.queue = [];
        this.queue_lock = false;
        this.active_queue_message = null;

        this.now_playing_message = null;

        this.ready_lock = false;
        this.destroyed = false;

        // @ts-ignore
        this.voice_connection.on("stateChange", (_, new_state) => this.voice_state_change(new_state));

        // @ts-ignore
        this.audio_player.on("stateChange", (old_state, new_state) => this.player_state_change(old_state, new_state));
        this.audio_player.on("error", (error: { message: string; name: string; resource: any; }) => {
            console.warn(error);

            const embed = new Discord.MessageEmbed()
                .setColor('#FF0000')
                .addField('Error', error.message);
            this.text_channel.send({ embeds: [embed] }).then((handle) => setTimeout(() => handle.delete(), 30000));
        });

        this.voice_connection.subscribe(this.audio_player);
    }

    async voice_state_change(new_state: DiscordVoice.VoiceConnectionState) {
        if (new_state.status === DiscordVoice.VoiceConnectionStatus.Disconnected) {
            if (new_state.reason === DiscordVoice.VoiceConnectionDisconnectReason.WebSocketClose && new_state.closeCode === 4014) {
                /**
                 * If the WebSocket closed with a 4014 code, this means that we should not manually attempt to reconnect,
                 * but there is a chance the connection will recover itself if the reason of the disconnect was due to
                 * switching voice channels. This is also the same code for the bot being kicked from the voice channel,
                 * so we allow 5 seconds to figure out which scenario it is. If the bot has been kicked, we should destroy
                 * the voice connection.
                 */
                try {
                    await DiscordVoice.entersState(this.voice_connection, DiscordVoice.VoiceConnectionStatus.Connecting, 5_000);
                    // Probably moved voice channel
                } catch {
                    this.voice_connection.destroy();
                    this.text_channel.send("y u kick :(");
                    // Probably removed from voice channel
                }
            } else if (this.voice_connection.rejoinAttempts < 5) {
                /**
                 * The disconnect in this case is recoverable, and we also have <5 repeated attempts so we will reconnect.
                 */
                await wait((this.voice_connection.rejoinAttempts + 1) * 5_000);
                this.voice_connection.rejoin();
            } else {
                /**
                 * The disconnect in this case may be recoverable, but we have no more remaining attempts - destroy.
                 */
                this.voice_connection.destroy();
            }
        } else if (new_state.status === DiscordVoice.VoiceConnectionStatus.Destroyed) {
            /**
             * Once destroyed, stop the subscription.
             */
            this.stop();
        } else if (
            !this.ready_lock &&
            (new_state.status === DiscordVoice.VoiceConnectionStatus.Connecting || new_state.status === DiscordVoice.VoiceConnectionStatus.Signalling)
        ) {
            /**
             * In the Signalling or Connecting states, we set a 20 second time limit for the connection to become ready
             * before destroying the voice connection. This stops the voice connection permanently existing in one of these
             * states.
             */
            this.ready_lock = true;
            try {
                await DiscordVoice.entersState(this.voice_connection, DiscordVoice.VoiceConnectionStatus.Ready, 20_000);
            } catch {
                if (this.voice_connection.state.status !== DiscordVoice.VoiceConnectionStatus.Destroyed) this.voice_connection.destroy();
            } finally {
                this.ready_lock = false;
            }
        }
    }

    async player_state_change(old_state: DiscordVoice.AudioPlayerState, new_state: DiscordVoice.AudioPlayerState) {
        if (new_state.status === DiscordVoice.AudioPlayerStatus.Idle && old_state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            // now idle, play next track if available
            // (old_state.resource as DiscordVoice.AudioResource<Track>).metadata.on_finish();
            void this.process_queue();
        } else if (new_state.status === DiscordVoice.AudioPlayerStatus.Playing) {
            // entered playing state, started next track
            const embed = new Discord.MessageEmbed()
                .setColor('#0099FF')
                .addField('Now playing', (new_state.resource as DiscordVoice.AudioResource<Track>).metadata.title);

            if (this.now_playing_message)
                this.now_playing_message.delete();

            const message = await this.text_channel.send({ embeds: [embed] });
            this.now_playing_message = message;

            const emojis: Map<string, string> = new Map([
                ["⏯", "play_pause"],
                ["⏩", "skip"]
            ]);

            const filter = (_: any, user: Discord.User) => user.id !== Bot.the().client.user?.id;
            const reactionCollector = message.createReactionCollector({ filter });
            reactionCollector.on("collect", async (reaction) => {
                if (!reaction.emoji.name)
                    return;

                switch (emojis.get(reaction.emoji.name)) {
                    case "play_pause":
                        if (!this.audio_player.unpause()) {
                            this.audio_player.pause();
                            reaction.users.fetch().then((users) => {
                                for (let [id, user] of users)
                                    if (id !== Bot.the().client.user?.id)
                                        reaction.users.remove(user);
                            });
                        }
                        break;
                    case "skip": this.skip("0"); break;
                }
            });

            for (let emoji of emojis.keys())
                message.react(emoji);
        }
    }

    check_voice_channel(message: Discord.Message) {
        return message.member?.voice.channel === this.voice_channel;
    }

    wrong_voice_channel() {
        let embed = new Discord.MessageEmbed();
        embed.setColor("#FF0000");
        embed.setDescription("Please join the corrent voice channel.");
        return embed;
    }

    move(source: string, target: string) {
        let embed = new Discord.MessageEmbed();

        const from = string_to_index(source, this.queue.length);
        const to = string_to_index(target, this.queue.length);

        if (
            (from !== to)
            && (from >= 0 && from < this.queue.length)
            && (to >= 0 && to < this.queue.length)
        ) {
            embed.setColor("#0099FF");
            embed.setDescription(`Moved *${this.queue[from].title}* to index ${to}`);

            for (let i = from; i > to; i -= 1) {
                const temp = this.queue[i - 1];
                this.queue[i - 1] = this.queue[i];
                this.queue[i] = temp;
            }
        } else {
            embed.setColor("#FF0000");
            embed.setDescription("Incorrect index or indices");
        }

        return embed;
    }

    pause() {
        let embed = new Discord.MessageEmbed();

        if (this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            this.audio_player.pause();

            embed.setColor("#0099FF");
            embed.setDescription("Paused");
        }

        return embed;
    }

    async play(url: string) {
        let embed = new Discord.MessageEmbed();

        try {
            if (YTPL.validateID(url)) {
                const playlist = await YTPL(url, { limit: Infinity });
                let duration = 0;
                for (let item of playlist.items) {
                    const track = new Track(item.shortUrl, item.title, item.durationSec || 0);
                    this.enqueue(track);
                    duration += item.durationSec || 0;
                }

                embed
                    .setColor("#00FF00")
                    .setThumbnail(playlist.thumbnails[0].url || "")
                    .addField("Added playlist", `[${playlist.title}](${playlist.url})`)
                    .addField("Length", seconds_to_hms(duration), true)
                    .addField("Tracks", playlist.items.length.toString(), true);
            } else if (YTDL.validateURL(url)) {
                const info = await YTDL.getInfo(url);
                const video = info.videoDetails;
                const track = new Track(url, video.title, parseInt(video.lengthSeconds));
                this.enqueue(track);

                embed
                    .setColor("#00FF00")
                    .setThumbnail(video.thumbnails[0].url)
                    .addField("Added track", `[${track.title}](${url})`)
                    .addField("Length", seconds_to_hms(track.length))
            } else {
                const filters = await YTSR.getFilters(url);
                const filter = filters.get("Type")?.get("Video");
                const results = await YTSR(filter?.url || "", { limit: 1 });
                const firstResult = results.items[0];
                if (firstResult.type !== "video")
                    return;
                const info = await YTDL.getInfo(firstResult.url);
                const video = info.videoDetails;
                const track = new Track(firstResult.url, firstResult.title, parseInt(video.lengthSeconds));
                this.enqueue(track);

                embed
                    .setColor("#00FF00")
                    .setThumbnail(video.thumbnails[0].url)
                    .addField("Added track", `[${track.title}](${firstResult.url})`)
                    .addField("Length", seconds_to_hms(track.length));
            }
        } catch (error) {
            console.warn(error);
            let embed = new Discord.MessageEmbed();
            embed.setColor("#FF0000");
            embed.setDescription("Failed to play track.");
            this.text_channel.send({ embeds: [embed] });
        }

        return embed;
    }

    skip(amount: string) {
        let embed = new Discord.MessageEmbed();

        if (this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            const current_title = (this.audio_player.state.resource as DiscordVoice.AudioResource<Track>).metadata.title;

            if (amount) {
                let amount_num = parseInt(amount) - 1;
                if (amount_num > this.queue.length) {
                    amount_num = this.queue.length;
                }

                this.queue.splice(0, amount_num);

                embed.addField("Skipped", `${current_title} and the next ${amount_num - 1} tracks.`);
            } else {
                embed.addField("Skipped", current_title);
            }

            this.audio_player.stop();
            embed.setColor("#0099FF");
        }

        return embed;
    }

    remove(index: string) {
        let embed = new Discord.MessageEmbed();
        const idx = string_to_index(index, this.queue.length);

        if (idx >= 0 && idx < this.queue.length) {
            embed.setColor("#0099FF");
            embed.addField("Removed track", this.queue[idx].title);

            this.queue.splice(idx, 1);
        } else {
            embed.setColor("#FF0000");
            embed.addField("Incorrect index", "😭");
        }

        return embed;
    }

    resume() {
        let embed = new Discord.MessageEmbed();

        if (this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            this.audio_player.unpause();

            embed.setColor("#0099FF");
            embed.setDescription("Resumed");
        }

        return embed;
    }

    shuffle() {
        shuffle(this.queue);

        return new Discord.MessageEmbed()
            .setColor("#0099FF")
            .setDescription("Shuffled queue");
    }

    now_playing() {
        if (this.audio_player.state.status === DiscordVoice.AudioPlayerStatus.Idle)
            return;

        const resource = (this.audio_player.state.resource as DiscordVoice.AudioResource<Track>);
        const current_time = seconds_to_hms(Math.floor(resource.playbackDuration / 1000));
        const total_time = seconds_to_hms(resource.metadata.length);
        return `*${resource.metadata.title}* - ${current_time} / ${total_time}`;
    }

    stringify_queue(page: string): { page: number, pages: number, queue: string } | null {
        if (this.queue.length <= 0)
            return null;

        const tracksPerPage = 10;
        const pages = parseInt(Math.ceil(this.queue.length / 10).toFixed(0));
        let page_num = string_to_index(page, pages);

        if (page_num >= pages)
            page_num = pages - 1;
        if (isNaN(page_num) || page_num < 0)
            page_num = 0;

        let queue = "";

        for (let i = page_num * tracksPerPage; i < Math.min(this.queue.length, (page_num + 1) * tracksPerPage); ++i) {
            const track = this.queue[i];
            queue += `**${(i + 1)}** - *${track.title}* - ${seconds_to_hms(track.length)}\n`;
        }

        return { page: page_num, pages, queue };
    }

    enqueue(track: Track) {
        this.queue.push(track);
        this.process_queue();
    }

    clear_queue() {
        this.queue = [];

        let embed = new Discord.MessageEmbed();
        embed.setColor("#0099FF");
        embed.setDescription("Cleared queue");
        return embed;
    }

    stop() {
        this.queue_lock = true;
        this.queue = [];
        this.audio_player.stop(true);
    }

    async process_queue(retry_count = 0): Promise<any> {
        if (this.queue_lock || this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle || this.queue.length <= 0)
            return;

        this.queue_lock = true;

        const next_track = this.queue.shift();
        // Attempt to convert the Track into an AudioResource (i.e. start streaming the video)
        next_track?.create_audio_resource().then((resource) => {
            this.audio_player.play(resource);
            this.queue_lock = false;
        }).catch((error) => {
            // If an error occurred, try the next item of the queue instead
            console.warn(error);

            const embed = new Discord.MessageEmbed()
                .setColor('#FF0000')
                .addField('Error', error.message);
            this.text_channel.send({ embeds: [embed] }).then((handle) => setTimeout(() => handle.delete(), 30000));

            if (retry_count < 5) {
                this.queue.unshift(next_track);
            } else {
                retry_count = -1;
            }
            this.queue_lock = false;
            return this.process_queue(retry_count + 1);
        });
    }

    destroy() {
        this.voice_connection.destroy();
    }
}
