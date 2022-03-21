import * as FS from "fs";
import * as Discord from "discord.js";
import * as DiscordVoice from "@discordjs/voice";
import { AudioConnection } from "./audio_connection.js";
import { Bot } from "./bot.js"

export class GuildConnection {
    text_channel: Discord.TextChannel;
    prefix: string;

    private audio_connection: AudioConnection | null;

    constructor(text_channel: Discord.TextChannel) {
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

        this.audio_connection = new AudioConnection(voice_channel, this.text_channel);
    }

    async command_clear(message: Discord.Message, _args: string[]): Promise<Discord.MessageEmbed> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return this.audio_connection.wrong_voice_channel();

            return this.audio_connection.clear_queue();
        }

        return new Discord.MessageEmbed();
    }

    async command_help(_message: Discord.Message, _args: string[]): Promise<Discord.MessageEmbed> {
        return new Discord.MessageEmbed()
            .setColor("#0099FF")
            .setTitle("Commands")
            .setDescription(`
                **clear** - Clear the queue
                **help** - Show this menu
                **leave** - Make me leave the voice channel :(
                **move** - Move a track from one position to another
                **pause** - Pause music playback
                **play** - Add a YouTube video or playlist to the queue or search for one
                **prefix** - Change the prefix
                **queue** - Show the tracks in the queue
                **skip** - Skip the current track and optionally more
                **remove** - Remove a track from the queue
                **resume** - Resume paused music playback
                **shuffle** - Shuffle the queue
            `)
            .setFooter({ text: `The current prefix is ${this.prefix}` });
    }

    async command_leave(message: Discord.Message, _args: string[]): Promise<Discord.MessageEmbed> {
        let embed = new Discord.MessageEmbed();

        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return this.audio_connection.wrong_voice_channel();

            this.audio_connection.destroy();
            this.audio_connection = null;

            embed.setColor("#FF0000");
            embed.setDescription("bai 👋🏻");
        }

        return embed;
    }

    async command_move(message: Discord.Message, args: string[]): Promise<Discord.MessageEmbed> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return this.audio_connection.wrong_voice_channel();

            return this.audio_connection.move(args[0], args[1]);
        }

        return new Discord.MessageEmbed();
    }

    async command_pause(message: Discord.Message, _args: string[]): Promise<Discord.MessageEmbed> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return this.audio_connection.wrong_voice_channel();

            return this.audio_connection.pause();
        }

        return new Discord.MessageEmbed();
    }

    async command_play(message: Discord.Message, args: string[]): Promise<Discord.MessageEmbed> {
        const voice_channel = message.member?.voice.channel;
        if (voice_channel && voice_channel instanceof Discord.VoiceChannel) {
            this.request_voice_connection(voice_channel);
        } else {
            return new Discord.MessageEmbed()
                .setColor("#FF0000")
                .setDescription("Please join a voice channel.");
        }

        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return this.audio_connection.wrong_voice_channel();

            const result = await this.audio_connection.play(args.join(' '));
            if (result)
                return result;
        }

        return new Discord.MessageEmbed();
    }

    async command_prefix(_message: Discord.Message, args: string[]): Promise<Discord.MessageEmbed> {
        this.update_prefix(args[0]);

        let embed = new Discord.MessageEmbed();
        embed.setColor("#00FF00")
        embed.setDescription(`Prefix changed to: ${this.prefix}`);
        return embed;
    }

    async command_queue(message: Discord.Message, args: string[]): Promise<Discord.MessageEmbed> {
        let embed = new Discord.MessageEmbed();

        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return this.audio_connection.wrong_voice_channel();

            const page = args[0];
            const queue_obj = this.audio_connection.stringify_queue(page);
            const now_playing = this.audio_connection.now_playing();

            embed.setColor("#0099FF");
            if (now_playing) {
                embed.setTitle("Now Playing");
                embed.setDescription(now_playing);

                if (queue_obj) {
                    embed.addField("Coming up", queue_obj.queue);
                    embed.setFooter({ text: `Page ${queue_obj.page + 1} / ${queue_obj.pages}` });
                }
            } else if (queue_obj) {
                embed.setTitle("Coming up");
                embed.setDescription(queue_obj.queue);
                embed.setFooter({ text: `Page ${queue_obj.page + 1} / ${queue_obj.pages}` });
            }
        }

        return embed;
    }

    command_queue_callback(message: Discord.Message) {
        if (!this.audio_connection)
            return;

        if (this.audio_connection.active_queue_message)
            this.audio_connection.active_queue_message.delete();

        this.audio_connection.active_queue_message = message;

        const emojis: Map<string, string> = new Map([
            ["⏮", "first"],
            ["◀", "previous"],
            ["▶", "next"],
            ["⏭", "last"],
            ["🔀", "shuffle"],
            ["🔄", "refresh"]
        ]);

        const filter = (_: any, user: Discord.User) => user.id !== Bot.the().client.user?.id;
        const reactionCollector = message.createReactionCollector({ filter });
        reactionCollector.on("collect", async (reaction) => {
            reaction.users.fetch().then((users) => {
                for (let [id, user] of users)
                    if (id !== Bot.the().client.user?.id)
                        reaction.users.remove(user);
            });

            if (!reaction.emoji.name)
                return;

            const footer = message.embeds[0].footer?.text.split(' ');
            let page, pages;
            if (footer) {
                page = parseInt(footer[1]);
                pages = parseInt(footer[3]);
            }
            switch (emojis.get(reaction.emoji.name)) {
                case "first": message.edit({ embeds: [await this.command_queue(message, ["1"])] }); break;
                case "previous": message.edit({ embeds: [await this.command_queue(message, [page ? (page - 1).toString() : "1"])] }); break;
                case "next": message.edit({ embeds: [await this.command_queue(message, [page ? (page + 1).toString() : "1"])] }); break;
                case "last": message.edit({ embeds: [await this.command_queue(message, [pages ? pages.toString() : "1"])] }); break;
                case "shuffle":
                    if (this.audio_connection)
                        this.audio_connection.shuffle();
                    message.edit({ embeds: [await this.command_queue(message, [page ? page.toString() : "1"])] });
                    break;
                case "refresh": message.edit({ embeds: [await this.command_queue(message, [page ? page.toString() : "1"])] }); break;
            }
        });

        for (let emoji of emojis.keys())
            message.react(emoji);
    }

    async command_skip(message: Discord.Message, args: string[]): Promise<Discord.MessageEmbed> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return this.audio_connection.wrong_voice_channel();

            return this.audio_connection.skip(args[0]);
        }

        return new Discord.MessageEmbed();
    }

    async command_remove(message: Discord.Message, args: string[]): Promise<Discord.MessageEmbed> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return this.audio_connection.wrong_voice_channel();

            return this.audio_connection.remove(args[0]);
        }

        return new Discord.MessageEmbed();
    }

    async command_resume(message: Discord.Message, _args: string[]): Promise<Discord.MessageEmbed> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return this.audio_connection.wrong_voice_channel();

            return this.audio_connection.resume();
        }

        return new Discord.MessageEmbed();
    }

    async command_shuffle(message: Discord.Message, _args: string[]): Promise<Discord.MessageEmbed> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return this.audio_connection.wrong_voice_channel();

            return this.audio_connection.shuffle();
        }

        return new Discord.MessageEmbed();
    }

    async command_unknown(_message: Discord.Message, _args: string[]): Promise<Discord.MessageEmbed> {
        let embed = new Discord.MessageEmbed();
        embed.setColor("#FF0000")
        embed.setDescription(`Unknown command, use \`${this.prefix}help\` for a list of commands.`);
        return embed;
    }
}
