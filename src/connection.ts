import * as FS from "fs";
import * as Util from "util";
import * as Discord from "discord.js";
import * as DiscordVoice from "@discordjs/voice";
import { default as YTPL } from "ytpl";
import { default as YTDL } from "ytdl-core";
import { default as YTSR } from "ytsr";
import { Track } from "./track.js";
import { seconds_to_hms } from "./utils.js";

const wait = Util.promisify(setTimeout);

interface Text {
    channel: Discord.TextChannel;
}

interface Voice {
    channel: Discord.VoiceChannel;
    connection: DiscordVoice.VoiceConnection;
    player: DiscordVoice.AudioPlayer;
}

class Queue {
    tracks: Array<Track>;
    lock: boolean;
    active_message: Discord.Message | null;

    constructor() {
        this.tracks = [];
        this.lock = false;
        this.active_message = null;
    }
}

export class GuildConnection {
    text: Text;
    voice: Voice;
    client: Discord.Client;
    queue: Queue;
    prefix: string;

    ready_lock: boolean;
    destroyed: boolean;

    constructor(
        text_channel: Discord.TextChannel,
        voice_channel: Discord.VoiceChannel,
        voice_connection: DiscordVoice.VoiceConnection,
        client: Discord.Client
    ) {
        this.text = { channel: text_channel };
        this.voice = {
            channel: voice_channel,
            connection: voice_connection,
            player: DiscordVoice.createAudioPlayer()
        };
        this.client = client;
        this.queue = new Queue();

        this.ready_lock = false;
        this.destroyed = false;

        this.prefix = this.get_prefix();

        // @ts-ignore
        this.voice.connection.on("stateChange", (_, new_state) => this.voice_state_change(new_state));
        // @ts-ignore
        this.voice.player.on("stateChange", (old_state, new_state) => this.player_state_change(old_state, new_state));
        this.voice.player.on("error", (error: { message: string; name: string; resource: any; }) => (error.resource as DiscordVoice.AudioResource<Track>).metadata.on_error(error, this.text.channel));

        voice_connection.subscribe(this.voice.player);
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
                    await DiscordVoice.entersState(this.voice.connection, DiscordVoice.VoiceConnectionStatus.Connecting, 5_000);
                    // Probably moved voice channel
                } catch {
                    this.voice.connection.destroy();
                    this.text.channel.send("y u kick :(");
                    // Probably removed from voice channel
                }
            } else if (this.voice.connection.rejoinAttempts < 5) {
                /**
                 * The disconnect in this case is recoverable, and we also have <5 repeated attempts so we will reconnect.
                 */
                await wait((this.voice.connection.rejoinAttempts + 1) * 5_000);
                this.voice.connection.rejoin();
            } else {
                /**
                 * The disconnect in this case may be recoverable, but we have no more remaining attempts - destroy.
                 */
                this.voice.connection.destroy();
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
                await DiscordVoice.entersState(this.voice.connection, DiscordVoice.VoiceConnectionStatus.Ready, 20_000);
            } catch {
                if (this.voice.connection.state.status !== DiscordVoice.VoiceConnectionStatus.Destroyed) this.voice.connection.destroy();
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
            (new_state.resource as DiscordVoice.AudioResource<Track>).metadata.on_start(this.text.channel);
        }
    }

    get_prefix() {
        try {
            return FS.readFileSync(`db/prefixes/${this.client.user?.id}/${this.text.channel.guild.id}`, "utf8").trim();
        } catch {
            return '$';
        }
    }

    update_prefix(new_prefix: string) {
        this.prefix = new_prefix;
        try {
            FS.accessSync(`db/prefixes/${this.client.user?.id}`);
        } catch {
            FS.mkdirSync(`db/prefixes/${this.client.user?.id}`);
        }
        FS.writeFileSync(`db/prefixes/${this.client.user?.id}/${this.text.channel.guild.id}`, this.prefix);
    }

    async play(message: Discord.Message) {
        const url = message.content.slice(message.content.indexOf(" ") + 1);

        if (message.member?.voice.channel !== this.voice.channel) {
            await message.reply("Join the correct voice channel and then try that again!");
            console.log("plz join correct channel");
            return;
        }

        try {
            await DiscordVoice.entersState(this.voice.connection, DiscordVoice.VoiceConnectionStatus.Ready, 20e3);
        } catch (error) {
            console.warn(error);
            await message.reply("Failed to join voice channel within 20 seconds, please try again later!");
            return;
        }

        try {
            if (YTPL.validateID(url)) {
                const playlist = await YTPL(url, { limit: Infinity });
                let duration = 0;
                for (let item of playlist.items) {
                    const track = new Track(item.shortUrl, item.title, item.durationSec || 0);
                    this.enqueue(track);
                    duration += item.durationSec || 0;
                }

                const embed = new Discord.MessageEmbed()
                    .setColor("#00FF00")
                    .setThumbnail(playlist.thumbnails[0].url || "")
                    .addField("Added playlist", `[${playlist.title}](${playlist.url})`)
                    .addField("Length", seconds_to_hms(duration), true)
                    .addField("Tracks", playlist.items.length.toString(), true);

                message.reply({ embeds: [embed] });
            } else if (YTDL.validateURL(url)) {
                const info = await YTDL.getInfo(url);
                const video = info.videoDetails;
                const track = new Track(url, video.title, parseInt(video.lengthSeconds));
                this.enqueue(track);

                const embed = new Discord.MessageEmbed()
                    .setColor("#00FF00")
                    .setThumbnail(video.thumbnails[0].url)
                    .addField("Added track", `[${track.title}](${url})`)
                    .addField("Length", seconds_to_hms(track.length))

                message.reply({ embeds: [embed] });
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

                const embed = new Discord.MessageEmbed()
                    .setColor("#00FF00")
                    .setThumbnail(video.thumbnails[0].url)
                    .addField("Added track", `[${track.title}](${firstResult.url})`)
                    .addField("Length", seconds_to_hms(track.length));

                message.reply({ embeds: [embed] });
            }
        } catch (error) {
            console.warn(error);
            this.text.channel.send("Failed to play track, please try again later!");
        }
    }

    enqueue(track: Track) {
        this.queue.tracks.push(track);
        this.process_queue();
    }

    stop() {
        this.queue.lock = true;
        this.queue.tracks = [];
        this.voice.player.stop(true);
    }

    async process_queue(): Promise<any> {
        if (this.queue.lock || this.voice.player.state.status !== DiscordVoice.AudioPlayerStatus.Idle || this.queue.tracks.length <= 0)
            return;

        this.queue.lock = true;

        const next_track = this.queue.tracks.shift();
        // Attempt to convert the Track into an AudioResource (i.e. start streaming the video)
        next_track?.create_audio_resource().then((resource) => {
            this.voice.player.play(resource);
            this.queue.lock = false;
        }).catch((error) => {
            // If an error occurred, try the next item of the queue instead
            next_track.on_error(error, this.text.channel);
            this.queue.tracks.unshift(next_track);
            this.queue.lock = false;
            return this.process_queue();
        });
    }
}
