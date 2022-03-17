import * as Discord from "discord.js";
import * as DiscordVoice from "@discordjs/voice";
import { GuildConnection } from "./connection.js";
import { Track } from "./track.js";
import { shuffle, string_to_index, seconds_to_hms } from "./utils.js";

// https://discord.js.org/#/docs/main/stable/class/ClientUser?scrollTo=setActivity

// enum MessageType {
//     Bind,
//     Clear,
//     Help,
//     Leave,
//     Move,
//     Pause,
//     Play,
//     Prefix,
//     Queue,
//     // FIXME: Seek,
//     Skip,
//     Remove,
//     Resume,
//     Shuffle,
//     Unknown
// }

export class Bot {
    connections: Map<Discord.Snowflake, GuildConnection>;
    client: Discord.Client;

    constructor(token: string) {
        this.connections = new Map();

        this.client = new Discord.Client({
            intents: [
                Discord.Intents.FLAGS.GUILD_VOICE_STATES,
                Discord.Intents.FLAGS.GUILD_MESSAGES,
                Discord.Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
                Discord.Intents.FLAGS.GUILDS,
            ]
        });

        this.client.once("ready", this.on_ready);
        this.client.on("error", this.on_error);
        this.client.on("messageCreate", (message) => this.on_message_create(message));

        this.client.login(token);
    }

    on_ready(client: Discord.Client) {
        console.log(`${client.user?.tag} ready!`);
    }

    on_error(error: Error) {
        console.warn(error);
    }

    async on_message_create(message: Discord.Message) {
        if (!message.guild || message.member?.id === this.client.user?.id || message.member?.user.bot) return;

        // FIXME: make a server connection on any message, but only make a voiceconnection when requested
        let server_connection = this.connections.get(message.guild.id);
        if (server_connection && server_connection.destroyed) {
            this.connections.delete(message.guild.id);
            server_connection = undefined;
        }

        if (!server_connection && message.member instanceof Discord.GuildMember) {
            if (
                message.member.voice.channel
                && message.member.voice.channel instanceof Discord.VoiceChannel
                && message.channel instanceof Discord.TextChannel
            ) {
                const voiceChannel = message.member.voice.channel;
                server_connection = new GuildConnection(message.channel, voiceChannel,
                    DiscordVoice.joinVoiceChannel({
                        channelId: voiceChannel.id,
                        guildId: voiceChannel.guild.id,
                        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                        selfDeaf: true,
                    }), this.client
                );
                server_connection.voice.connection.on("error", console.warn);
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
            case "p": case "play":
                void server_connection.play(message);
                break;
            case "s": case "skip":
                if (server_connection && server_connection.voice.player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
                    let embed = new Discord.MessageEmbed();

                    let amount_str = message.content.split(" ")[1];
                    if (amount_str !== undefined && amount_str !== "") {
                        let amount = parseInt(amount_str) - 1;
                        if (amount > server_connection.queue.tracks.length) {
                            amount = server_connection.queue.tracks.length;
                        }

                        server_connection.queue.tracks.splice(0, amount);

                        embed.setColor("#0099FF");
                        embed.addField("Skipped", `Next ${amount} tracks.`);
                    } else {
                        embed.setColor("#0099FF");
                        embed.addField("Skipped", (server_connection.voice.player.state.resource as DiscordVoice.AudioResource<Track>).metadata.title);
                    }

                    server_connection.voice.player.stop();

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "q": case "queue":
                if (server_connection) {
                    const embed = new Discord.MessageEmbed()
                        .setColor("#0099FF")
                        .setTitle("Now Playing");

                    if (server_connection.voice.player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
                        const nowPlaying = (server_connection.voice.player.state.resource as DiscordVoice.AudioResource<Track>).metadata.title;

                        const currentTime = seconds_to_hms(Math.floor((server_connection.voice.player.state.resource as DiscordVoice.AudioResource<Track>).playbackDuration / 1000));
                        const totalTime = seconds_to_hms((server_connection.voice.player.state.resource as DiscordVoice.AudioResource<Track>).metadata.length);

                        embed.setDescription(`*${nowPlaying}* - ${currentTime} / ${totalTime}`);
                    } else {
                        embed.setDescription("Not currently playing");
                    }

                    if (server_connection.queue.tracks.length > 0) {
                        const tracksPerPage = 10;
                        const pages = parseInt(Math.ceil(server_connection.queue.tracks.length / 10).toFixed(0));
                        let page = string_to_index(message.content.split(" ")[1], pages);

                        if (page >= pages)
                            page = pages - 1;
                        if (isNaN(page) || page < 0)
                            page = 0;

                        let queue = "";

                        for (let i = page * tracksPerPage; i < Math.min(server_connection.queue.tracks.length, (page + 1) * tracksPerPage); ++i) {
                            const track = server_connection.queue.tracks[i];
                            queue += `**${(i + 1)}** - *${track.title}* - ${seconds_to_hms(track.length)}\n`;
                        }

                        embed.addField("Queue", queue);
                        embed.setFooter({ text: "Page " + (page + 1) + "/" + pages });
                    }

                    message.channel.send({ embeds: [embed] }).then((handle) => {
                        if (!server_connection) return;

                        if (server_connection.queue.active_message)
                            server_connection.queue.active_message.delete();

                        server_connection.queue.active_message = handle;

                        // const emojis = {
                        //     "⏮": "first",
                        //     "◀": "previous",
                        //     "▶": "next",
                        //     "⏭": "last",
                        //     "⏬": "skip",
                        // };

                        // const filter = (_: any, user: Discord.User) => user.id !== this.client.user?.id;
                        // const reactionCollector = handle.createReactionCollector({ filter });
                        // reactionCollector.on("collect", (reaction) => {
                        //     reaction.users.fetch()
                        //         .then((users) => {
                        //             for (let [id, user] of users) {
                        //                 if (id !== this.client.user?.id)
                        //                     reaction.users.remove(user);
                        //             }
                        //         });

                        //     // switch(emojis[reaction.emoji.name]) {
                        //     //     case "first":

                        //     // }
                        // });

                        // for (let emoji of Object.keys(emojis))
                        //     handle.react(emoji);
                    });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "sh": case "shuffle":
                if (server_connection) {
                    shuffle(server_connection.queue.tracks);

                    const embed = new Discord.MessageEmbed()
                        .setColor("#0099FF")
                        .addField("Shuffled queue", "🔀");

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "r": case "remove":
                if (server_connection) {
                    const index = string_to_index(message.content.split(" ")[1], server_connection.queue.tracks.length);

                    let embed = new Discord.MessageEmbed();

                    if (index >= 0 && index < server_connection.queue.tracks.length) {
                        embed.setColor("#0099FF");
                        embed.addField("Removed track", server_connection.queue.tracks[index].title);

                        server_connection.queue.tracks.splice(index, 1);
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
                    let embed = new Discord.MessageEmbed();

                    const parts = message.content.split(" ");
                    const source = string_to_index(parts[1], server_connection.queue.tracks.length);
                    const target = string_to_index(parts[2], server_connection.queue.tracks.length);

                    if (
                        (source !== target)
                        && (source >= 0 && source < server_connection.queue.tracks.length)
                        && (target >= 0 && target < server_connection.queue.tracks.length)
                    ) {
                        embed.setColor("#0099FF");
                        embed.addField("Moved track", server_connection.queue.tracks[source].title);

                        for (let i = source; i > target; --i) {
                            const temp = server_connection.queue.tracks[i - 1];
                            server_connection.queue.tracks[i - 1] = server_connection.queue.tracks[i];
                            server_connection.queue.tracks[i] = temp;
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
                    server_connection.queue.tracks = [];

                    const embed = new Discord.MessageEmbed()
                        .setColor("#0099FF")
                        .addField("Cleared queue", "⏹");

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "pa": case "pause":
                if (server_connection && server_connection.voice.player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
                    server_connection.voice.player.pause();

                    const embed = new Discord.MessageEmbed()
                        .setColor("#0099FF")
                        .addField("Paused", "⏸");

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "re": case "resume":
                if (server_connection && server_connection.voice.player.state.status !== DiscordVoice.AudioPlayerStatus.Idle) {
                    server_connection.voice.player.unpause();

                    const embed = new Discord.MessageEmbed()
                        .setColor("#0099FF")
                        .addField("Resumed", "▶");

                    message.reply({ embeds: [embed] });
                } else {
                    void Bot.not_playing(message);
                }
                break;
            case "l": case "leave": case "die":
                if (server_connection) {
                    server_connection.voice.connection.destroy();
                    this.connections.delete(message.guild.id);

                    const embed = new Discord.MessageEmbed()
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
                const embed = new Discord.MessageEmbed()
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

    // parse_message(message: Discord.Message): MessageType {

    //     return MessageType.Help;
    // }

    static async not_playing(message: Discord.Message) {
        const embed = new Discord.MessageEmbed()
            .setColor("#FF0000")
            .addField("Not currently playing", "🤷🏻");

        message.reply({ embeds: [embed] });
    }
}

const _bot = new Bot(process.argv[2]);
