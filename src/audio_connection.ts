import * as Discord from "discord.js";
import * as DiscordVoice from "@discordjs/voice";
import * as ChildProcess from "child_process";
import * as Util from "util";
import { Innertube, YTNodes } from 'youtubei.js';
import YTMusic, { SongDetailed } from "ytmusic-api";
import { SpotifyApi } from "@spotify/web-api-ts-sdk";
import { Bot } from "./bot.js";
import { Track } from "./track.js";
import { shuffle, seconds_to_hms, hms_to_seconds, string_to_index } from "./utils.js";
import { GuildConnection } from "./guild_connection.js";
import tokens from "./config.json" assert { type: "json" };

const wait = Util.promisify(setTimeout);

interface SpotifyEmbed {
    title: string,
    id: string,
    coverArt: {
        sources: {
            url: string,
        }[]
    },
    trackList: {
        title: string,
        subtitle: string,
    }[],
}

interface SpotifyTrackList {
    next: string | null,
    items: {
        track: {
            name: string,
            artists: {
                name: string,
            }[],
        }
    }[],
}

export class AudioConnection {
    private guild_connection: GuildConnection;

    private voice_channel: Discord.Snowflake;
    voice_connection: DiscordVoice.VoiceConnection;

    private audio_player: DiscordVoice.AudioPlayer;

    private queue: Track[];
    private queue_lock: boolean;
    active_queue_message: Discord.Message | null;
    loop: boolean;
    private current_track: Track | undefined;

    private volume: number;

    private now_playing_message: Discord.Message | null;

    private ready_lock: boolean;
    destroyed: boolean;
    private leave_timer: NodeJS.Timeout | undefined;

    private innertube: Innertube;

    private ytmusic: YTMusic;
    did_init: boolean;

    private spotify: SpotifyApi | null;

    constructor(voice_channel: Discord.VoiceChannel, guild_connection: GuildConnection) {
        this.guild_connection = guild_connection;

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

        this.volume = 1;

        this.now_playing_message = null;

        this.ready_lock = false;
        this.destroyed = false;

        this.ytmusic = new YTMusic();
        this.did_init = false;

        this.spotify = null;

        Bot.the().client.on("voiceStateUpdate", (old_state) => this.voice_channel_state_update(old_state));

        this.voice_connection.on("stateChange", (_, new_state) => this.voice_state_change(new_state));

        this.audio_player.on("stateChange", (old_state, new_state) => this.player_state_change(old_state, new_state));
        this.audio_player.on("error", (error: { message: string; name: string; resource: DiscordVoice.AudioResource; }) => {
            console.warn(error);

            const embed = new Discord.EmbedBuilder()
                .setColor("Red")
                .addFields([{ name: "Error", value: error.message }]);
            this.guild_connection.text_channel.send({ embeds: [embed] }).then((handle) => setTimeout(() => handle.delete(), 30000));
        });

        this.voice_connection.subscribe(this.audio_player);
    }

    async init() {
        if (this.did_init)
            return;

        this.innertube = await Innertube.create({ location: "NL" });

        await this.ytmusic.initialize({ GL: "NL" });

        if (!tokens.spotify_client_id || !tokens.spotify_client_secret) {
            console.log("Found empty Spotify credentials, disabling playlist length >100 support");
        } else {
            console.log("Found Spotify credentials, trying to enable playlist length >100 support");
            this.spotify = SpotifyApi.withClientCredentials(tokens.spotify_client_id, tokens.spotify_client_secret, []);
        }

        this.did_init = true;
    }

    async voice_channel_state_update(old_state: Discord.VoiceState) {
        clearTimeout(this.leave_timer);

        if (old_state.channel?.members.size === 1) {
            this.leave_timer = setTimeout(() => {
                const embed = new Discord.EmbedBuilder()
                    .setColor("Red")
                    .setDescription(`Left the voice channel after ${this.guild_connection.config.leave_delay} minutes of inactivity!`);
                this.guild_connection.text_channel.send({ embeds: [embed] });
                this.destroy();
            }, this.guild_connection.config.leave_delay * 60 * 1000);
        }
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
                    const embed = new Discord.EmbedBuilder()
                        .setColor("Red")
                        .setDescription("Kicked from the voice channel! :(");
                    this.guild_connection.text_channel.send({ embeds: [embed] });
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
            Bot.the().client.removeAllListeners("voiceStateUpdate");
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

            if (this.loop && this.current_track) {
                this.queue.unshift(this.current_track);
            }

            void this.process_queue();
        } else if (new_state.status === DiscordVoice.AudioPlayerStatus.Playing) {
            // entered playing state, started next track
            const embed = new Discord.EmbedBuilder()
                .setColor("Blue")
                .addFields([{ name: "Now playing", value: this.now_playing_resource()?.metadata.title || "---" }]);

            if (this.now_playing_message) {
                this.now_playing_message.delete();
                this.now_playing_message = null;
            }

            const message = await this.guild_connection.text_channel.send({ embeds: [embed] });
            this.now_playing_message = message;

            const emojis = new Map<string, string>([
                ["⏯", "play_pause"],
                ["⏩", "skip"],
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
                message.react(emoji).catch(error => console.error(error));
        }
    }

    check_voice_channel(message: Discord.Message) {
        return message.member?.voice.channelId === this.voice_channel;
    }

    wrong_voice_channel() {
        return new Discord.EmbedBuilder()
            .setColor("Red")
            .setDescription("Please join the correct voice channel.");
    }

    now_playing_resource() {
        if (this.audio_player.state.status === DiscordVoice.AudioPlayerStatus.Idle)
            return null;

        return (this.audio_player.state.resource as DiscordVoice.AudioResource<Track>);
    }

    move(source: string, target: string) {
        const embed = new Discord.EmbedBuilder();

        const from = string_to_index(source, this.queue.length);
        const to = string_to_index(target, this.queue.length);

        if (from && to &&
            (from !== to)
            && (from >= 0 && from < this.queue.length)
            && (to >= 0 && to < this.queue.length)
        ) {
            embed.setColor("Green");
            embed.setDescription(`Moved *${this.queue[from].title}* to location ${to + 1}`);

            for (let i: number = from; i > to; i -= 1) {
                const temp = this.queue[i - 1];
                this.queue[i - 1] = this.queue[i];
                this.queue[i] = temp;
            }
        } else {
            embed.setColor("Red");
            embed.setDescription("Incorrect index or indices");
        }

        return embed;
    }

    pause() {
        const embed = new Discord.EmbedBuilder();

        if (this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            this.audio_player.pause();

            embed.setColor("Green");
            embed.setDescription("Paused");
        }

        return embed;
    }

    async search_yt_and_add(search_term: string, embed: Discord.EmbedBuilder) {
        const result = (await this.innertube.search(search_term, { type: "video" })).results.firstOfType(YTNodes.Video);
        if (!result) {
            return;
        }

        const track = new Track(result.video_id, result.title.toString(), result.duration.seconds);
        this.enqueue(track);

        embed.setColor("Green");
        if (result.best_thumbnail) {
            embed.setThumbnail(result.best_thumbnail.url);
        }
        return embed.addFields([
            { name: "Added track", value: `[${track.title}](https://youtu.be/${result.video_id})` },
            { name: "Length", value: seconds_to_hms(track.length) }
        ]);
    }

    async search_ytmusic_and_add(search_term: string, embed: Discord.EmbedBuilder) {
        const tracks = await this.ytmusic.searchSongs(search_term);
        const track = new Track("https://music.youtube.com/watch?v=" + tracks[0].videoId, tracks[0].name, tracks[0].duration || 0);
        this.enqueue(track);

        embed.setColor("Green");
        embed.setThumbnail(tracks[0].thumbnails[0].url);
        return embed.addFields([
            { name: "Added track", value: `[${track.title}](https://music.youtube.com/watch?v=${tracks[0].videoId})` },
            { name: "Length", value: seconds_to_hms(track.length) }
        ]);
    }

    async play(args: string[]) {
        const embed = new Discord.EmbedBuilder();

        try {
            if (args[0].includes("open.spotify.com")) {
                await this.add_from_spotify(args[0], embed);
                return embed;
            }

            const nav = await this.innertube.resolveURL(args[0]);
            const videoId = nav.payload.videoId;

            if (nav.payload.playlistId === "RD" + videoId) {
                embed.setColor("Blue");
                embed.setDescription("Processing YouTube Mix⏳");

                this.add_youtube_mix(args[0]);
                return embed;
            }

            if (nav.metadata.page_type === "WEB_PAGE_TYPE_PLAYLIST" || nav.payload.playlistId) {
                const playlist = await this.innertube.getPlaylist(nav.payload.playlistId || nav.payload.browseId);
                if (!playlist) {
                    throw Error("Unable to get playlist.");
                }

                let count = 0, duration = 0;
                for (const item of playlist.items.filterType(YTNodes.PlaylistVideo)) {
                    const track = new Track(item.id, item.title.toString(), item.duration.seconds);
                    this.enqueue(track);
                    ++count;
                    duration += track.length;
                }

                embed.setColor("Green");
                const thumbnail = playlist.items.firstOfType(YTNodes.PlaylistVideo)?.thumbnails[0]?.url;
                if (thumbnail) {
                    embed.setThumbnail(thumbnail);
                }
                embed.addFields([
                    { name: "Added playlist", value: `[${playlist.info.title?.toString()}](${args[0]})` },
                    { name: "Length", value: seconds_to_hms(duration) },
                    { name: "Tracks", value: count.toString() }
                ]);

                return embed;
            }

            if (videoId) {
                const info = (await this.innertube.getBasicInfo(videoId)).basic_info;
                const track = new Track(videoId, info.title || "", info.duration || 0);
                this.enqueue(track);

                embed.setColor("Green");
                if (info.thumbnail) {
                    embed.setThumbnail(info.thumbnail[0].url);
                }
                embed.addFields([
                    { name: "Added track", value: `[${track.title}](https://youtu.be/${videoId})` },
                    { name: "Length", value: seconds_to_hms(track.length) }
                ]);
                return embed;
            }

            const search_term = args.join(" ");
            return await this[`search_${this.guild_connection.config.search_provider}_and_add`](search_term, embed);
        } catch (error) {
            console.warn(error);
            return embed
                .setColor("Red")
                .setDescription("Failed to play track.");
        }
    }

    async add_youtube_mix(url: string) {
        ChildProcess.execFile("yt-dlp", [
            "--quiet",
            "--print", "%(id)s %(duration)i %(title)s",
            "--flat-playlist",
            "--playlist-items", `1:${this.guild_connection.config.mix_items}`,
            "--no-check-certificates",
            "--no-cache-dir",
            url,
        ], (error, stdout) => {
            const embed = new Discord.EmbedBuilder();
            if (error) {
                console.error(error);
                embed.setColor("Red");
                embed.setDescription("Could not add Mix");
                this.guild_connection.text_channel.send({ embeds: [embed] });
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

            embed.setColor("Green");
            embed.setTitle("Added Mix");
            embed.addFields([
                { name: "Length", value: seconds_to_hms(duration) },
                { name: "Tracks", value: count.toString() }
            ]);
            this.guild_connection.text_channel.send({ embeds: [embed] });
        });
    }

    async add_from_spotify(url: string, embed: Discord.EmbedBuilder) {
        url = url.split("?si=")[0];
        if (!url.includes("/embed/"))
            url = url.replace(".com/", ".com/embed/");

        try {
            const response = await fetch(url);
            const text = await response.text();
            const match = text.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
            if (match) {
                const json = JSON.parse(match[1]);
                const data = json.props.pageProps.state.data.entity;

                if (data.type === "playlist") {
                    embed.setColor("Blue");
                    embed.setDescription("Processing Spotify playlist⏳");

                    this.add_spotify_playlist(data);
                } else {
                    let search_term = "";
                    for (const artist of data.artists) {
                        search_term += `${artist.name} & `;
                    }
                    search_term = search_term.slice(0, search_term.length - 2);
                    search_term += `- ${data.title}`;
                    await this.search_ytmusic_and_add(search_term, embed);
                }
            }
        } catch (error) {
            console.error(error);
            embed.setColor("Red");
            embed.setDescription("Could not get track(s) from Spotify!");
        }

        return embed;
    }

    async add_spotify_playlist(data: SpotifyEmbed) {
        const searches: Promise<SongDetailed[]>[] = [];
        for (const item of data.trackList) {
            const search_term = `${item.subtitle} - ${item.title}`;
            searches.push(this.ytmusic.searchSongs(search_term));
        }

        try {
            if (this.spotify && data.trackList.length === 100) {
                let next = data.id + "/tracks?offset=100&limit=100";
                for (; ;) {
                    const response: SpotifyTrackList = await this.spotify.makeRequest("GET", "playlists/" + next);

                    for (const { track } of response.items) {
                        let artists = "";
                        for (const artist of track.artists) {
                            artists += `${artist.name} & `;
                        }
                        artists = artists.slice(0, artists.length - 2);
                        const search_term = `${artists} - ${track.name}`;
                        searches.push(this.ytmusic.searchSongs(search_term));
                        await wait(10);
                    }

                    if (response.next) {
                        next = response.next.split("v1/playlists/")[1];
                    } else {
                        break;
                    }
                }
            }
        } catch (error) {
            console.error("Possibly incorrect Spotify API credentials:", error);
        }

        let duration = 0;
        await Promise.allSettled(searches).then(tracks => {
            let fullfilled = 0;
            for (const promise of tracks) {
                if (promise.status === "rejected")
                    continue;
                fullfilled += 1;

                const result = promise.value[0];
                duration += result.duration || 0;
                this.enqueue(new Track(result.videoId, result.name, result.duration || 0));
            }

            const embed = new Discord.EmbedBuilder;
            embed.setColor("Green");
            embed.setThumbnail(data.coverArt.sources[0].url || "");
            embed.addFields([
                { name: "Added Spotify playlist", value: `[${data.title}](https://open.spotify.com/playlist/${data.id})` },
                { name: "Length", value: seconds_to_hms(duration) },
                { name: "Tracks", value: fullfilled.toString() }
            ]);
            this.guild_connection.text_channel.send({ embeds: [embed] });
        }).catch(error => {
            console.error(error);
        });
    }

    skip(amount: string) {
        const embed = new Discord.EmbedBuilder();

        const resource = this.now_playing_resource();
        if (!resource)
            return embed;

        if (amount) {
            let amount_num = parseInt(amount) - 1;
            if (amount_num > this.queue.length)
                amount_num = this.queue.length;

            this.queue.splice(0, amount_num);

            embed.addFields([{ name: "Skipped", value: `${resource.metadata.title} and the next ${amount_num} tracks.` }]);
        } else {
            embed.addFields([{ name: "Skipped", value: resource.metadata.title }]);
        }

        this.audio_player.stop();
        embed.setColor("Green");

        return embed;
    }

    remove(index: string) {
        const embed = new Discord.EmbedBuilder();
        const idx = string_to_index(index, this.queue.length);

        if (idx && idx >= 0 && idx < this.queue.length) {
            embed.setColor("Green");
            embed.addFields([{ name: "Removed track", value: this.queue[idx].title }]);

            this.queue.splice(idx, 1);
        } else {
            embed.setColor("Red");
            embed.addFields([{ name: "Incorrect index", value: "😭" }]);
        }

        return embed;
    }

    resume() {
        const embed = new Discord.EmbedBuilder();

        if (this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
            this.audio_player.unpause();

            embed.setColor("Green");
            embed.setDescription("Resumed");
        }

        return embed;
    }

    seek(timestamp: string) {
        const embed = new Discord.EmbedBuilder();

        if (this.current_track) {
            const seconds = Math.min(this.current_track.length, hms_to_seconds(timestamp));
            embed.setColor("Blue");
            embed.setDescription("Seeking to " + seconds_to_hms(seconds) + ".");
            this.get_audio_resource(0, seconds);
            return embed;
        }

        embed.setColor("Red");
        embed.setDescription("Failed to seek.");
        return embed;
    }

    shuffle() {
        shuffle(this.queue);

        return new Discord.EmbedBuilder()
            .setColor("Green")
            .setDescription("Shuffled queue");
    }

    now_playing() {
        const resource = this.now_playing_resource();
        if (!resource)
            return null;

        let current_time_s = Math.floor(resource.playbackDuration / 1000);
        if (this.current_track)
            current_time_s += this.current_track.start_time;

        const current_time = seconds_to_hms(current_time_s);
        const total_time = seconds_to_hms(resource.metadata.length);
        return `*${resource.metadata.title}* - ${current_time} / ${total_time}`;
    }

    stringify_queue(page: string): { page: number, pages: number, queue: string } | null {
        if (this.queue.length <= 0)
            return null;

        const tracksPerPage = 10;
        const pages = parseInt(Math.ceil(this.queue.length / 10).toFixed(0));
        let page_num = string_to_index(page, pages) || 0;

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

        return new Discord.EmbedBuilder()
            .setColor("Green")
            .setDescription("Cleared queue");
    }

    set_volume(volume: string) {
        const embed = new Discord.EmbedBuilder();

        const parsed_volume = parseInt(volume);
        if (isNaN(parsed_volume) || parsed_volume < 0) {
            embed.setColor("Red");
            embed.setDescription("Invalid volume, please enter a number of 0% or higher. (Above 200% at your own risk)");
            return embed;
        }

        this.volume = parsed_volume / 100;

        const resource = this.now_playing_resource();
        if (resource) {
            let current_time_s = resource.playbackDuration / 1000;
            if (this.current_track)
                current_time_s += this.current_track.start_time;
            this.get_audio_resource(0, current_time_s);
        } else {
            this.get_audio_resource(0);
        }

        embed.setColor("Blue");
        embed.setDescription("Set volume to: " + parsed_volume + "%");
        return embed;
    }

    stop() {
        this.queue_lock = true;
        this.queue = [];
        this.audio_player.stop(true);
    }

    async process_queue(retry_count = 0) {
        if (this.queue_lock || this.audio_player.state.status !== DiscordVoice.AudioPlayerStatus.Idle)
            return;

        this.current_track?.destroy();
        this.current_track = undefined;

        if (this.queue.length <= 0)
            return;

        this.queue_lock = true;

        this.current_track = this.queue.shift();
        // Attempt to convert the Track into an AudioResource (i.e. start streaming the video)
        this.get_audio_resource(retry_count);
    }

    get_audio_resource(retry_count: number, timestamp = 0) {
        if (!this.current_track) {
            return;
        }

        this.current_track.destroy();

        this.current_track.start_time = timestamp;
        this.current_track.create_audio_resource(this.volume, timestamp).then((resource) => {
            this.audio_player.play(resource);
            this.queue_lock = false;
        }).catch((error) => {
            // If an error occurred, try the next item of the queue instead
            console.warn(error);

            const embed = new Discord.EmbedBuilder()
                .setColor("Red")
                .addFields([{ name: "Error", value: error.message }]);
            this.guild_connection.text_channel.send({ embeds: [embed] }).then((handle) => setTimeout(() => handle.delete(), 30000));

            if (retry_count < 5 && this.current_track) {
                this.queue.unshift(this.current_track);
            } else {
                retry_count = -1;
            }

            this.queue_lock = false;
            return this.process_queue(retry_count + 1);
        });
    }

    destroy() {
        clearTimeout(this.leave_timer);

        if (this.destroyed)
            return;

        this.voice_connection.destroy();
        this.destroyed = true;
    }
}
