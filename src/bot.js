import { Client, GuildMember, MessageEmbed, Intents } from "discord.js";
import {
    AudioPlayerStatus,
    joinVoiceChannel,
    VoiceConnectionStatus,
    entersState
} from "@discordjs/voice";
import { GuildConnection } from "./connection.js";
import { Track } from './track.js';
import { shuffle, stringToIndex, secondsToHms } from "./utils.js";
import ytdl from 'ytdl-core';
import ytpl from 'ytpl';
import ytsr from 'ytsr';

// https://discord.js.org/#/docs/main/stable/class/ClientUser?scrollTo=setActivity



export class Bot {
    constructor(token) {
        this.connections = new Map();

        this.client = new Client({
            intents: [
                Intents.FLAGS.GUILD_VOICE_STATES,
                Intents.FLAGS.GUILD_MESSAGES,
                Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
                Intents.FLAGS.GUILDS
            ]
        });

        this.client.on("ready", this.ready);
        this.client.on("error", this.error);
        this.client.on("messageCreate", async (message) => this.message_create(message));

        this.client.login(token);
    }

    ready() {
        console.log("ready!");
    }

    error(err) {
        console.warn(err);
    }

    async message_create(message) {
        if (!message.guild || message.member?.id === this.client.user?.id || message.member?.bot) return;

        // FIXME: make a server connection on any message, but only make a voiceconnection when requested
        let server_connection = this.connections.get(message.guild.id);
        if (server_connection && server_connection.destroyed) {
            this.connections.delete(message.guild.id);
            server_connection = undefined;
        }

        if (!server_connection && message.member instanceof GuildMember) {
            if (message.member.voice.channel) {
                const voiceChannel = message.member.voice.channel;
                server_connection = new GuildConnection(message.channel, voiceChannel.id,
                    joinVoiceChannel({
                        channelId: voiceChannel.id,
                        guildId: voiceChannel.guild.id,
                        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                        selfDeaf: true,
                    }), this.client.user?.id,
                );
                server_connection.voiceConnection.on("error", console.warn);
                this.connections.set(message.guild?.id, server_connection);
            } else {
                message.reply("Please join a voice channel.");
                return;
            }
        }

        if (!server_connection) {
            message.reply("wtf");
            return;
        }

        const prefix = message.content.slice(0, server_connection.prefix.length);
        if (prefix !== server_connection.prefix)
            return;

        const command = message.content.slice(server_connection.prefix.length).split(" ")[0];
        switch (command) {
            // FIXME: add seek
            case "p": case "play":
                void this.play(message, server_connection);
                break;
            case "s": case "skip":
                if (server_connection && server_connection.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
                    let embed = new MessageEmbed();

                    let amount = message.content.split(" ")[1];
                    if (amount !== undefined && amount !== "") {
                        amount = parseInt(amount) - 1;
                        if (amount > server_connection.queue.length) {
                            amount = server_connection.queue.length;
                        }

                        server_connection.queue.splice(0, amount);

                        embed.setColor("#0099FF");
                        embed.addField("Skipped", `Next ${amount} tracks.`);
                    } else {
                        embed.setColor("#0099FF");
                        embed.addField("Skipped", server_connection.audioPlayer.state.resource.metadata.title);
                    }

                    server_connection.audioPlayer.stop();

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "q": case "queue":
                if (server_connection) {
                    const embed = new MessageEmbed()
                        .setColor("#0099FF")
                        .setTitle("Now Playing");

                    if (server_connection.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
                        const nowPlaying = server_connection.audioPlayer.state.resource.metadata.title;

                        const currentTime = secondsToHms(Math.floor(server_connection.audioPlayer.state.resource.playbackDuration / 1000));
                        const totalTime = secondsToHms(server_connection.audioPlayer.state.resource.metadata.length);

                        embed.setDescription(`*${nowPlaying}* - ${currentTime} / ${totalTime}`);
                    } else {
                        embed.setDescription("Not currently playing");
                    }

                    if (server_connection.queue.length > 0) {
                        const tracksPerPage = 10;
                        const pages = Math.ceil(server_connection.queue.length / 10).toFixed(0);
                        let page = stringToIndex(message.content.split(" ")[1], pages);

                        if (page >= pages)
                            page = pages - 1;
                        if (isNaN(page) || page < 0)
                            page = 0;

                        let queue = "";

                        for (let i = page * tracksPerPage; i < Math.min(server_connection.queue.length, (page + 1) * tracksPerPage); ++i) {
                            const track = server_connection.queue[i];
                            queue += `**${(i + 1)}** - *${track.title}* - ${secondsToHms(track.length)}\n`;
                        }

                        embed.addField("Queue", queue);
                        embed.setFooter({ text: "Page " + (page + 1) + "/" + pages });
                    }

                    message.channel.send({ embeds: [embed] }).then((handle) => {
                        if (server_connection.activeQueueMessage) server_connection.activeQueueMessage.delete();
                        server_connection.activeQueueMessage = handle;

                        const emojis = {
                            "⏮": "first",
                            "◀": "previous",
                            "▶": "next",
                            "⏭": "last",
                            "⏬": "skip",
                        };

                        const filter = (_, user) => user.id !== this.client.user.id;
                        const reactionCollector = handle.createReactionCollector({ filter });
                        reactionCollector.on("collect", (reaction) => {
                            reaction.users.fetch()
                                .then((users) => {
                                    for (let [id, user] of users) {
                                        if (id !== this.client.user.id)
                                            reaction.users.remove(user);
                                    }
                                });

                            // switch(emojis[reaction.emoji.name]) {
                            //     case "first":

                            // }
                        });

                        for (let emoji of Object.keys(emojis))
                            handle.react(emoji);
                    });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "sh": case "shuffle":
                if (server_connection) {
                    shuffle(server_connection.queue);

                    const embed = new MessageEmbed()
                        .setColor("#0099FF")
                        .addField("Shuffled queue", "🔀");

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "r": case "remove":
                if (server_connection) {
                    const index = stringToIndex(message.content.split(" ")[1], server_connection.queue.length);

                    let embed = new MessageEmbed();

                    if (index >= 0 && index < server_connection.queue.length) {
                        embed.setColor("#0099FF");
                        embed.addField("Removed track", server_connection.queue[index].title);

                        server_connection.queue.splice(index, 1);
                    } else {
                        embed.setColor("#FF0000");
                        embed.addField("Incorrect index", "😭");
                    }

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "m": case "move":
                if (server_connection) {
                    let embed = new MessageEmbed();

                    const parts = message.content.split(" ");
                    const source = stringToIndex(parts[1], server_connection.queue.length);
                    const target = stringToIndex(parts[2], server_connection.queue.length);

                    if (
                        (source !== target)
                        && (source >= 0 && source < server_connection.queue.length)
                        && (target >= 0 && target < server_connection.queue.length)
                    ) {
                        embed.setColor("#0099FF");
                        embed.addField("Moved track", server_connection.queue[source].title);

                        for (let i = source; i > target; --i) {
                            const temp = server_connection.queue[i - 1];
                            server_connection.queue[i - 1] = server_connection.queue[i];
                            server_connection.queue[i] = temp;
                        }
                    } else {
                        embed.setColor("#FF0000");
                        embed.addField("Incorrect index or indices", "😭");
                    }

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "c": case "clear":
                if (server_connection) {
                    server_connection.queue = [];

                    const embed = new MessageEmbed()
                        .setColor("#0099FF")
                        .addField("Cleared queue", "⏹");

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "pa": case "pause":
                if (server_connection && server_connection.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
                    server_connection.audioPlayer.pause();

                    const embed = new MessageEmbed()
                        .setColor("#0099FF")
                        .addField("Paused", "⏸");

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "re": case "resume":
                if (server_connection && server_connection.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
                    server_connection.audioPlayer.unpause();

                    const embed = new MessageEmbed()
                        .setColor("#0099FF")
                        .addField("Resumed", "▶");

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "l": case "leave": case "die":
                if (server_connection) {
                    server_connection.voiceConnection.destroy();
                    this.activeConnections.delete(message.guild.id);

                    const embed = new MessageEmbed()
                        .setColor("#FF0000")
                        .addField("bai", "👋🏻");

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "pr": case "prefix":
                if (server_connection) {
                    server_connection.update_prefix(message.content.split(" ")[1]);
                    message.reply("Prefix changed to `" + server_connection.prefix + "`.");
                }
                break;
            case "h": case "help":
                const embed = new MessageEmbed()
                    .setColor("#0099FF")
                    .addField(server_connection.prefix, "The current prefix")
                    .addField("p, play", "Add a YouTube song or playlist to the queue or search for a video")
                    .addField("s, skip", "Skip the current song or an amount")
                    .addField("q, queue", "See the music queue")
                    .addField("r, remove", "Remove a track by index")
                    .addField("m, move", "Move a track from one to another index")
                    .addField("c, clear", "Clear the queue")
                    .addField("pa, pause", "Pause music playback")
                    .addField("re, resume", "Resume music playback")
                    .addField("l, leave, die", "Leave the voice channel")
                    .addField("pr, prefix", "Change the prefix")
                    .addField("h, help", "Show this menu")
                    .setFooter({ text: "P.S. kick me if i break" });

                message.reply({ embeds: [embed] });
                break;
            default:
                message.reply("Unknown command, use `" + server_connection.prefix + "h` or `" + server_connection.prefix + "help` for a list of commands.");
                break;
        }
    }

    async play(message, server_connection) {
        const url = message.content.slice(message.content.indexOf(" ") + 1);

        if (message.member.voice.channelId !== server_connection.voiceChannel) {
            await message.reply("Join the correct voice channel and then try that again!");
            console.log("plz join correct channel");
            return;
        }

        try {
            await entersState(server_connection.voiceConnection, VoiceConnectionStatus.Ready, 20e3);
        } catch (error) {
            console.warn(error);
            await message.reply("Failed to join voice channel within 20 seconds, please try again later!");
            return;
        }

        try {
            if (ytpl.validateID(url)) {
                const playlist = await ytpl(url, { limit: Infinity });
                let duration = 0;
                for (let item of playlist.items) {
                    const track = new Track(item.shortUrl, item.title, item.durationSec);
                    server_connection.enqueue(track);
                    duration += item.durationSec;
                }

                const embed = new MessageEmbed()
                    .setColor("#00FF00")
                    .setThumbnail(playlist.thumbnails[0].url)
                    .addField("Added playlist", `[${playlist.title}](${playlist.url})`)
                    .addField("Length", secondsToHms(duration), true)
                    .addField("Tracks", playlist.items.length.toString(), true);

                message.reply({ embeds: [embed] });
            } else if (ytdl.validateURL(url)) {
                const info = await ytdl.getInfo(url);
                const video = info.videoDetails;
                const track = new Track(url, video.title, video.lengthSeconds);
                server_connection.enqueue(track);

                const embed = new MessageEmbed()
                    .setColor("#00FF00")
                    .setThumbnail(video.thumbnails[0].url)
                    .addField("Added track", `[${track.title}](${url})`)
                    .addField("Length", secondsToHms(video.lengthSeconds))

                message.reply({ embeds: [embed] });
            } else {
                const filters = await ytsr.getFilters(url);
                const filter = filters.get("Type").get("Video");
                const results = await ytsr(filter.url, { limit: 1 });
                const firstResult = results.items[0];
                const info = await ytdl.getInfo(firstResult.url);
                const video = info.videoDetails;
                const track = new Track(firstResult.url, firstResult.title, video.lengthSeconds);
                server_connection.enqueue(track);

                const embed = new MessageEmbed()
                    .setColor("#00FF00")
                    .setThumbnail(video.thumbnails[0].url)
                    .addField("Added track", `[${track.title}](${firstResult.url})`)
                    .addField("Length", secondsToHms(video.lengthSeconds));

                message.reply({ embeds: [embed] });
            }
        } catch (error) {
            console.warn(error);
            server_connection.text_channel.send("Failed to play track, please try again later!");
        }
    }

    static async not_playing(message) {
        const embed = new MessageEmbed()
            .setColor("#FF0000")
            .addField("Not currently playing", "🤷🏻");

        message.reply({ embeds: [embed] });
    }
}

const _bot = new Bot(process.argv[2]);
