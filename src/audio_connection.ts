import * as Discord from "discord.js";
import * as DiscordVoice from "@discordjs/voice";
import * as Util from "util";
import { default as YTPL } from "ytpl";
import { default as YTDL } from "ytdl-core";
import { default as YTSR } from "ytsr";
import { Track } from "./track.js";
import { shuffle, seconds_to_hms, string_to_index } from "./utils.js";

const wait = Util.promisify(setTimeout);

class Queue {
    tracks: Array<Track>;
    active_message: Discord.Message | null;
    lock: boolean;

    constructor() {
        this.tracks = [];
        this.active_message = null;
        this.lock = false;
    }
}

export class AudioConnection {
    private voice_channel: Discord.VoiceChannel;
    voice_connection: DiscordVoice.VoiceConnection;
    private audio_player: DiscordVoice.AudioPlayer;
    private queue: Queue;
    private ready_lock: boolean;
    destroyed: boolean;

    constructor(voice_channel: Discord.VoiceChannel) {
        this.voice_channel = voice_channel;
        this.voice_connection = DiscordVoice.joinVoiceChannel({
            channelId: this.voice_channel.id,
            guildId: this.voice_channel.guild.id,
            adapterCreator: this.voice_channel.guild.voiceAdapterCreator,
            selfDeaf: true
        });
        this.audio_player = DiscordVoice.createAudioPlayer();

        this.queue = new Queue();

        this.ready_lock = false;
        this.destroyed = false;

        // @ts-ignore
        this.voice_connection.on("stateChange", (_, new_state) => this.voice_state_change(new_state));
        // @ts-ignore
        this.audio_player.on("stateChange", (old_state, new_state) => this.player_state_change(old_state, new_state));
        //FIXME: this.audio_player.on("error", (error: { message: string; name: string; resource: any; }) => (error.resource as DiscordVoice.AudioResource<Track>).metadata.on_error(error, this.text.channel));

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
                    // FIXME: this.text.channel.send("y u kick :(");
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

    player_state_change(old_state: DiscordVoice.AudioPlayerState, new_state: DiscordVoice.AudioPlayerState) {
        if (new_state.status === DiscordVoice.AudioPlayerStatus.Idle && old_state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            // now idle, play next track if available
            (old_state.resource as DiscordVoice.AudioResource<Track>).metadata.on_finish();
            void this.process_queue();
        } else if (new_state.status === DiscordVoice.AudioPlayerStatus.Playing) {
            // entered playing state, started next track
            // FIXME: (new_state.resource as DiscordVoice.AudioResource<Track>).metadata.on_start(this.text.channel);
        }
    }

    async move(source: string, target: string) {
        let embed = new Discord.MessageEmbed();

        const from = string_to_index(source, this.queue.tracks.length);
        const to = string_to_index(target, this.queue.tracks.length);

        if (
            (from !== to)
            && (from >= 0 && from < this.queue.tracks.length)
            && (to >= 0 && to < this.queue.tracks.length)
        ) {
            embed.setColor("#0099FF");
            embed.addField("Moved track", this.queue.tracks[from].title);

            for (let i = from; i > to; i -= 1) {
                const temp = this.queue.tracks[i - 1];
                this.queue.tracks[i - 1] = this.queue.tracks[i];
                this.queue.tracks[i] = temp;
            }
        } else {
            embed.setColor("#FF0000");
            embed.addField("Incorrect index or indices", "😭");
        }

        return embed;
    }

    async pause() {
        let embed = new Discord.MessageEmbed();

        if (this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            this.audio_player.pause();

            embed
                .setColor("#0099FF")
                .addField("Paused", "⏸");
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
            // FIXME: this.text.channel.send("Failed to play track, please try again later!");
        }

        return embed;
    }

    skip(amount: string) {
        let embed = new Discord.MessageEmbed();

        if (this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            const current_title = (this.audio_player.state.resource as DiscordVoice.AudioResource<Track>).metadata.title;

            if (amount) {
                let amount_num = parseInt(amount) - 1;
                if (amount_num > this.queue.tracks.length) {
                    amount_num = this.queue.tracks.length;
                }

                this.queue.tracks.splice(0, amount_num);

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
        const idx = string_to_index(index, this.queue.tracks.length);

        if (idx >= 0 && idx < this.queue.tracks.length) {
            embed.setColor("#0099FF");
            embed.addField("Removed track", this.queue.tracks[idx].title);

            this.queue.tracks.splice(idx, 1);
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

            embed
                .setColor("#0099FF")
                .addField("Resumed", "▶");
        }

        return embed;
    }

    shuffle() {
        shuffle(this.queue.tracks);

        return new Discord.MessageEmbed()
            .setColor("#0099FF")
            .addField("Shuffled queue", "🔀");
    }

    now_playing() {
        if (this.audio_player.state.status === DiscordVoice.AudioPlayerStatus.Idle)
            return "Not currently playing";

        const resource = (this.audio_player.state.resource as DiscordVoice.AudioResource<Track>);
        const current_time = seconds_to_hms(Math.floor(resource.playbackDuration / 1000));
        const total_time = seconds_to_hms(resource.metadata.length);
        return `*${resource.metadata.title}* - ${current_time} / ${total_time}`;
    }

    stringify_queue(page: string): { queue: string, pages: number } | null {
        if (this.queue.tracks.length <= 0)
            return null;

        const tracksPerPage = 10;
        const pages = parseInt(Math.ceil(this.queue.tracks.length / 10).toFixed(0));
        let page_num = string_to_index(page, pages);

        if (page_num >= pages)
            page_num = pages - 1;
        if (isNaN(page_num) || page_num < 0)
            page_num = 0;

        let queue = "";

        for (let i = page_num * tracksPerPage; i < Math.min(this.queue.tracks.length, (page_num + 1) * tracksPerPage); ++i) {
            const track = this.queue.tracks[i];
            queue += `**${(i + 1)}** - *${track.title}* - ${seconds_to_hms(track.length)}\n`;
        }

        return { queue, pages };
    }

    enqueue(track: Track) {
        this.queue.tracks.push(track);
        this.process_queue();
    }

    clear_queue() {
        this.queue.tracks = [];

        return new Discord.MessageEmbed()
            .setColor("#0099FF")
            .addField("Cleared queue", "⏹");
    }

    stop() {
        this.queue.lock = true;
        this.queue.tracks = [];
        this.audio_player.stop(true);
    }

    async process_queue(): Promise<any> {
        if (this.queue.lock || this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle || this.queue.tracks.length <= 0)
            return;

        this.queue.lock = true;

        const next_track = this.queue.tracks.shift();
        // Attempt to convert the Track into an AudioResource (i.e. start streaming the video)
        next_track?.create_audio_resource().then((resource) => {
            this.audio_player.play(resource);
            this.queue.lock = false;
        }).catch((error) => {
            // If an error occurred, try the next item of the queue instead
            // FIXME: next_track.on_error(error, this.text.channel);
            this.queue.tracks.unshift(next_track);
            this.queue.lock = false;
            return this.process_queue();
        });
    }

    destroy() {
        this.voice_connection.destroy();
    }
}
