import * as Discord from "discord.js";
import * as DiscordVoice from "@discordjs/voice";
import * as ChildProcess from "child_process";
import * as Util from "util";
import { default as YTPL } from "ytpl";
import { default as YTDL } from "ytdl-core";
import { default as YTSR } from "ytsr";
import { Bot } from "./bot.js";
import { Track } from "./track.js";
import { shuffle, seconds_to_hms, string_to_index } from "./utils.js";

const wait = Util.promisify(setTimeout);

export class AudioConnection {
    text_channel: Discord.TextChannel;

    private voice_channel: Discord.Snowflake;
    voice_connection: DiscordVoice.VoiceConnection;

    private audio_player: DiscordVoice.AudioPlayer;

    private queue: Track[];
    private queue_lock: boolean;
    active_queue_message: Discord.Message | null;
    loop: boolean;
    private current_track: Track | undefined;

    private now_playing_message: Discord.Message | null;

    private ready_lock: boolean;
    destroyed: boolean;

    constructor(voice_channel: Discord.VoiceChannel, text_channel: Discord.TextChannel) {
        this.text_channel = text_channel;

        this.voice_channel = voice_channel.id;
        this.voice_connection = DiscordVoice.joinVoiceChannel({
            channelId: voice_channel.id,
            guildId: voice_channel.guild.id,
            adapterCreator: voice_channel.guild.voiceAdapterCreator,
            selfDeaf: true,
        });

        this.audio_player = DiscordVoice.createAudioPlayer();

        this.queue = [];
        this.queue_lock = false;
        this.active_queue_message = null;
        this.loop = false;
        this.current_track = undefined;

        this.now_playing_message = null;

        this.ready_lock = false;
        this.destroyed = false;

        // @ts-ignore: For some reason TypeScript won't accept this valid argument
        this.voice_connection.on("stateChange", (_, new_state) => this.voice_state_change(new_state));

        // @ts-ignore: For some reason TypeScript won't accept this valid argument
        this.audio_player.on("stateChange", (old_state, new_state) => this.player_state_change(old_state, new_state));
        this.audio_player.on("error", (error: { message: string; name: string; resource: DiscordVoice.AudioResource; }) => {
            console.warn(error);

            const embed = new Discord.MessageEmbed()
                .setColor("RED")
                .addField("Error", error.message);
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
                    if (this.voice_connection.joinConfig.channelId)
                        this.voice_channel = this.voice_connection.joinConfig.channelId;
                } catch {
                    this.destroy();
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
                this.destroy();
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
                if (this.voice_connection.state.status !== DiscordVoice.VoiceConnectionStatus.Destroyed) this.destroy();
            } finally {
                this.ready_lock = false;
            }
        }
    }

    async player_state_change(old_state: DiscordVoice.AudioPlayerState, new_state: DiscordVoice.AudioPlayerState) {
        if (new_state.status === DiscordVoice.AudioPlayerStatus.Idle && old_state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            // now idle, play next track if available
            if (this.now_playing_message) {
                this.now_playing_message.delete();
                this.now_playing_message = null;
            }

            if (this.loop) {
                this.current_track?.create_audio_resource().then((resource) => {
                    this.audio_player.play(resource);
                    return;
                });
            }

            void this.process_queue();
        } else if (new_state.status === DiscordVoice.AudioPlayerStatus.Playing) {
            // entered playing state, started next track
            const embed = new Discord.MessageEmbed()
                .setColor("BLUE")
                // @ts-ignore: No TypeScript, this cannot be null
                .addField("Now playing", this.now_playing_resource().metadata.title);

            if (this.now_playing_message) {
                this.now_playing_message.delete();
                this.now_playing_message = null;
            }

            const message = await this.text_channel.send({ embeds: [embed] });
            this.now_playing_message = message;

            const emojis: Map<string, string> = new Map([
                ["???", "play_pause"],
                ["???", "skip"],
            ]);

            const filter = (_: Discord.MessageReaction, user: Discord.User) => user.id !== Bot.the().client.user?.id;
            const reactionCollector = message.createReactionCollector({ filter });
            reactionCollector.on("collect", async (reaction) => {
                if (!reaction.emoji.name)
                    return;

                switch (emojis.get(reaction.emoji.name)) {
                    case "play_pause":
                        if (!this.audio_player.unpause()) {
                            this.audio_player.pause();
                            reaction.users.fetch().then((users) => {
                                for (const [id, user] of users) {
                                    if (id !== Bot.the().client.user?.id)
                                        reaction.users.remove(user);
                                }
                            });
                        }
                        break;
                    case "skip": this.skip("0"); break;
                }
            });

            for (const emoji of emojis.keys())
                message.react(emoji);
        }
    }

    check_voice_channel(message: Discord.Message) {
        return message.member?.voice.channelId === this.voice_channel;
    }

    wrong_voice_channel() {
        return new Discord.MessageEmbed()
            .setColor("RED")
            .setDescription("Please join the corrent voice channel.");
    }

    now_playing_resource() {
        if (this.audio_player.state.status === DiscordVoice.AudioPlayerStatus.Idle)
            return null;

        return (this.audio_player.state.resource as DiscordVoice.AudioResource<Track>);
    }

    move(source: string, target: string) {
        const embed = new Discord.MessageEmbed();

        const from = string_to_index(source, this.queue.length);
        const to = string_to_index(target, this.queue.length);

        if (
            (from !== to)
            && (from >= 0 && from < this.queue.length)
            && (to >= 0 && to < this.queue.length)
        ) {
            embed.setColor("GREEN");
            embed.setDescription(`Moved *${this.queue[from].title}* to index ${to}`);

            for (let i = from; i > to; i -= 1) {
                const temp = this.queue[i - 1];
                this.queue[i - 1] = this.queue[i];
                this.queue[i] = temp;
            }
        } else {
            embed.setColor("RED");
            embed.setDescription("Incorrect index or indices");
        }

        return embed;
    }

    pause() {
        const embed = new Discord.MessageEmbed();

        if (this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            this.audio_player.pause();

            embed.setColor("GREEN");
            embed.setDescription("Paused");
        }

        return embed;
    }

    async play(args: string[]) {
        const embed = new Discord.MessageEmbed();

        try {
            const url = args[0];
            if (url.includes("&list=RD")) {
                embed.setColor("BLUE");
                embed.setDescription("Processing YouTube Mix???");

                this.add_youtube_mix(url);
            } else if (YTPL.validateID(url)) {
                const playlist = await YTPL(url, { limit: Infinity });
                let duration = 0;
                for (const item of playlist.items) {
                    const track = new Track(item.shortUrl, item.title, item.durationSec || 0);
                    this.enqueue(track);
                    duration += item.durationSec || 0;
                }

                embed.setColor("GREEN");
                embed.setThumbnail(playlist.thumbnails[0].url || "");
                embed.addField("Added playlist", `[${playlist.title}](${playlist.url})`);
                embed.addField("Length", seconds_to_hms(duration), true);
                embed.addField("Tracks", playlist.items.length.toString(), true);
            } else if (YTDL.validateURL(url)) {
                const info = await YTDL.getInfo(url);
                const video = info.videoDetails;
                const track = new Track(url, video.title, parseInt(video.lengthSeconds));
                this.enqueue(track);

                embed.setColor("GREEN");
                embed.setThumbnail(video.thumbnails[0].url);
                embed.addField("Added track", `[${track.title}](${url})`);
                embed.addField("Length", seconds_to_hms(track.length));
            } else {
                const searchTerm = args.join(" ");
                const filters = await YTSR.getFilters(searchTerm);
                const filter = filters.get("Type")?.get("Video");
                const results = await YTSR(filter?.url || "", { limit: 1 });
                const firstResult = results.items[0];
                if (firstResult.type !== "video")
                    return;
                const info = await YTDL.getInfo(firstResult.url);
                const video = info.videoDetails;
                const track = new Track(firstResult.url, firstResult.title, parseInt(video.lengthSeconds));
                this.enqueue(track);

                embed.setColor("GREEN");
                embed.setThumbnail(video.thumbnails[0].url);
                embed.addField("Added track", `[${track.title}](${firstResult.url})`);
                embed.addField("Length", seconds_to_hms(track.length));
            }
        } catch (error) {
            console.warn(error);
            return new Discord.MessageEmbed()
                .setColor("RED")
                .setDescription("Failed to play track.");
        }

        return embed;
    }

    async add_youtube_mix(url: string) {
        ChildProcess.execFile("yt-dlp", [
            "--quiet",
            "--print", "%(id)s %(duration)i %(title)s",
            "--flat-playlist",
            "--no-check-certificates",
            "--no-cache-dir",
            "--no-call-home",
            url,
        ], (error, stdout) => {
            const embed = new Discord.MessageEmbed();
            if (error) {
                console.error(error);
                embed.setColor("RED");
                embed.setDescription("Could not add Mix");
                this.text_channel.send({ embeds: [embed] });
                return;
            }

            let count = 0;
            let duration = 0;

            const lines = stdout.trim().split("\n");
            for (const line of lines) {
                const parts = line.split(" ");
                const new_url = parts.shift() || "";
                const new_duration = parseInt(parts.shift() || "0");
                const title = parts.join(" ");
                const track = new Track(new_url, title, new_duration);
                this.enqueue(track);

                count += 1;
                duration += new_duration;
            }

            embed.setColor("GREEN");
            embed.setTitle("Added Mix");
            embed.addField("Length", seconds_to_hms(duration), true);
            embed.addField("Tracks", count.toString(), true);
            this.text_channel.send({ embeds: [embed] });
        });
    }

    skip(amount: string) {
        const embed = new Discord.MessageEmbed();

        const resource = this.now_playing_resource();
        if (!resource)
            return embed;

        if (amount) {
            let amount_num = parseInt(amount) - 1;
            if (amount_num > this.queue.length)
                amount_num = this.queue.length;

            this.queue.splice(0, amount_num);

            embed.addField("Skipped", `${resource.metadata.title} and the next ${amount_num - 1} tracks.`);
        } else {
            embed.addField("Skipped", resource.metadata.title);
        }

        this.audio_player.stop();
        embed.setColor("GREEN");

        return embed;
    }

    remove(index: string) {
        const embed = new Discord.MessageEmbed();
        const idx = string_to_index(index, this.queue.length);

        if (idx >= 0 && idx < this.queue.length) {
            embed.setColor("GREEN");
            embed.addField("Removed track", this.queue[idx].title);

            this.queue.splice(idx, 1);
        } else {
            embed.setColor("RED");
            embed.addField("Incorrect index", "????");
        }

        return embed;
    }

    resume() {
        const embed = new Discord.MessageEmbed();

        if (this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            this.audio_player.unpause();

            embed.setColor("GREEN");
            embed.setDescription("Resumed");
        }

        return embed;
    }

    shuffle() {
        shuffle(this.queue);

        return new Discord.MessageEmbed()
            .setColor("GREEN")
            .setDescription("Shuffled queue");
    }

    now_playing() {
        const resource = this.now_playing_resource();
        if (!resource)
            return null;

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

        return new Discord.MessageEmbed()
            .setColor("GREEN")
            .setDescription("Cleared queue");
    }

    stop() {
        this.queue_lock = true;
        this.queue = [];
        this.audio_player.stop(true);
    }

    async process_queue(retry_count = 0) {
        if (this.queue_lock || this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle || this.queue.length <= 0)
            return;

        this.queue_lock = true;

        this.current_track = this.queue.shift();
        // Attempt to convert the Track into an AudioResource (i.e. start streaming the video)
        this.current_track?.create_audio_resource().then((resource) => {
            this.audio_player.play(resource);
            this.queue_lock = false;
        }).catch((error) => {
            // If an error occurred, try the next item of the queue instead
            console.warn(error);

            const embed = new Discord.MessageEmbed()
                .setColor("RED")
                .addField("Error", error.message);
            this.text_channel.send({ embeds: [embed] }).then((handle) => setTimeout(() => handle.delete(), 30000));

            if (retry_count < 5) {
                // @ts-ignore: TypeScript needs to step up their static analysis, this cannot be undefined
                this.queue.unshift(this.current_track);
            } else {
                retry_count = -1;
            }

            this.queue_lock = false;
            return this.process_queue(retry_count + 1);
        });
    }

    destroy() {
        this.voice_connection.destroy();
        this.destroyed = true;
    }
}
