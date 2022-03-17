import * as FS from "fs";
import * as Discord from "discord.js";
import * as DiscordVoice from "@discordjs/voice";
import { AudioConnection } from "./audio_connection.js";
import { Bot } from "./bot.js"

export class GuildConnection {
    text_channel: Discord.TextChannel;
    prefix: string;

    private audio_connection: AudioConnection | null;

    constructor(
        text_channel: Discord.TextChannel,
    ) {
        this.text_channel = text_channel;
        this.prefix = this.get_prefix();

        this.audio_connection = null;
    }

    get_prefix() {
        try {
            return FS.readFileSync(`prefixes/${Bot.the().client.user?.id}/${this.text_channel.guildId}`, "utf8").trim();
        } catch {
            return '$';
        }
    }

    update_prefix(new_prefix: string) {
        this.prefix = new_prefix;
        try {
            FS.accessSync(`prefixes/${Bot.the().client.user?.id}`);
        } catch {
            FS.mkdirSync(`prefixes/${Bot.the().client.user?.id}`);
        }
        FS.writeFileSync(`prefixes/${Bot.the().client.user?.id}/${this.text_channel.guildId}`, this.prefix);
    }

    async request_voice_connection(voice_channel: Discord.VoiceChannel) {
        if (this.audio_connection && !this.audio_connection.destroyed) {
            DiscordVoice.entersState(this.audio_connection.voice_connection, DiscordVoice.VoiceConnectionStatus.Ready, 20e3)
                .catch((error) => {
                    console.warn(error);
                    this.text_channel.send("Failed to join voice channel within 20 seconds, please try again later!");
                });
            return;
        }

        this.audio_connection = new AudioConnection(voice_channel);
    }

    async command_clear(_args: string[]) {
        if (this.audio_connection)
            return this.audio_connection.clear_queue();
    }

    async command_help(_args: string[]) {
        return new Discord.MessageEmbed()
            .setColor("#0099FF")
            .addField(this.prefix, "The current prefix")
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
    }

    async command_leave(_args: string[]) {
        let embed = new Discord.MessageEmbed();

        if (this.audio_connection) {
            this.audio_connection.destroy();
            this.audio_connection = null;

            embed
                .setColor("#FF0000")
                .addField("bai", "👋🏻");
        }

        return embed;
    }

    async command_move(args: string[]) {
        if (this.audio_connection)
            return this.audio_connection.move(args[0], args[1]);
    }

    async command_pause(_args: string[]) {
        if (this.audio_connection)
            return this.audio_connection.pause();
    }

    async command_play(args: string[]) {
        if (this.audio_connection)
            return this.audio_connection.play(args[0]);
    }

    async command_prefix(args: string[]) {
        this.update_prefix(args[0]);
        // FIXME: message.reply("Prefix changed to `" + this.audio_connection.prefix + "`.");
    }

    async command_queue(args: string[]) {
        let embed = new Discord.MessageEmbed()

        if (this.audio_connection) {
            embed
                .setColor("#0099FF")
                .setTitle("Now Playing")
                .setDescription(this.audio_connection.now_playing());

            const page = args[0];
            let obj = this.audio_connection.stringify_queue(page);
            if (obj) {
                embed.addField("Queue", obj.queue);
                embed.setFooter({ text: `Page ${page + 1} / ${obj.pages}` });
            }

            return embed;
            // FIXME:
            // message.channel.send({ embeds: [embed] }).then((handle) => {
            //     if (!this.audio_connection) return;

            //     if (this.audio_connection.queue.active_message)
            //         this.audio_connection.queue.active_message.delete();

            //     this.audio_connection.queue.active_message = handle;

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
            // });
        }
    }

    async command_skip(args: string[]) {
        if (this.audio_connection)
            return this.audio_connection.skip(args[0]);
    }

    async command_remove(args: string[]) {
        if (this.audio_connection)
            return this.audio_connection.remove(args[0]);
    }

    async command_resume(_args: string[]) {
        if (this.audio_connection)
            return this.audio_connection.resume();
    }

    async command_shuffle(_args: string[]) {
        if (this.audio_connection)
            return this.audio_connection.shuffle();
    }

    async command_unknown(_args: string[]) {
        console.error("NOT IMPLEMENTED: GuildConnection.command_unknown");
        // FIXME: message.reply("Unknown command, use `" + server_connection.prefix + "h` or `" + server_connection.prefix + "help` for a list of commands.");
    }
}
