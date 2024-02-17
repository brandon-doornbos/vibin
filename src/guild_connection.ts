import * as FS from "fs";
import * as Discord from "discord.js";
import * as DiscordVoice from "@discordjs/voice";
import { find_lyrics } from "./lyrics.js";
import { AudioConnection } from "./audio_connection.js";
import { Bot } from "./bot.js";

interface GuildConfig {
    prefix: string,
    mix_items: number,
    leave_delay: number
}

export class GuildConnection {
    text_channel: Discord.TextChannel;

    private static config_options = {
        prefix: {
            type: "string",
            options: undefined,
            description: "prefix to invoke commands"
        }, mix_items: {
            type: "number",
            options: undefined,
            description: "amount of items to queue of a YouTube Mix"
        }, leave_delay: {
            type: "number",
            options: undefined,
            description: "amount of minutes to wait before leaving if the voice channel is empty"
        }
    };
    private static default_config: GuildConfig = { prefix: "$", mix_items: 100, leave_delay: 5 };
    config: GuildConfig;

    private audio_connection: AudioConnection | null;

    constructor(text_channel: Discord.TextChannel) {
        this.text_channel = text_channel;
        this.config = this.get_config();

        this.audio_connection = null;
    }

    get_config() {
        const options = structuredClone(GuildConnection.default_config);
        try {
            const saved_options = JSON.parse(FS.readFileSync(`config/${Bot.the().client.user?.id}/${this.text_channel.guildId}`, "utf8"));
            for (const [option, value] of Object.entries(saved_options)) {
                saved_options[option] = {
                    value,
                    configurable: true,
                    enumerable: true,
                    writable: true
                };
            }
            Object.defineProperties(options, saved_options);
        } catch (error) {
            console.error(error);
        }
        return options;
    }

    set_config() {
        try {
            FS.accessSync(`config/${Bot.the().client.user?.id}`);
        } catch {
            FS.mkdirSync(`config/${Bot.the().client.user?.id}`);
        }
        FS.writeFileSync(`config/${Bot.the().client.user?.id}/${this.text_channel.guildId}`, JSON.stringify(this.config));
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

        this.audio_connection = new AudioConnection(voice_channel, this);
    }

    async command_bind(message: Discord.Message): Promise<Discord.EmbedBuilder[]> {
        if (message.channel instanceof Discord.TextChannel) {
            this.text_channel = message.channel;

            return [new Discord.EmbedBuilder()
                .setColor("Green")
                .setDescription("Bound to text channel!")];
        }

        return [new Discord.EmbedBuilder()
            .setColor("Red")
            .setDescription("Failed to bind to text channel!")];
    }

    async command_clear(message: Discord.Message): Promise<Discord.EmbedBuilder[]> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            return [this.audio_connection.clear_queue()];
        }

        return [new Discord.EmbedBuilder()];
    }

    async command_help(): Promise<Discord.EmbedBuilder[]> {
        return [new Discord.EmbedBuilder()
            .setColor("Blue")
            .setTitle("Commands")
            .setDescription(`
                **bind** - Bind to a text channel
                **clear** - Clear the queue
                **help** - Show this menu
                **join** - Join the voice channel without playing anything
                **leave** - Make me leave the voice channel :(
                **loop** - Toggle looping the current track
                **lyrics** - Request the lyrics of a track or the currently playing one
                **move** - Move a track from one position to another
                **pause** - Pause music playback
                **play** - Use with a URL to, a YouTube video or playlist, a YouTube Music track or playlist or a Spotify track or playlist. Anything else will be interpreted as a search term for YouTube
                **config** - Configure bot, invoke to see options
                **queue** - Show the tracks in the queue
                **seek** - Seek to a specific time in the current track, takes hh:mm:ss (hh:mm: optional)
                **skip** - Skip the current track and optionally more
                **remove** - Remove a track from the queue
                **resume** - Resume paused music playback
                **shuffle** - Shuffle the queue
                **volume** - Set the volume of the bot, resets on join, takes a number of 0% or higher
            `)
            .setFooter({ text: `Use ${this.config.prefix} with a command or @ me` })];
    }

    async command_join(message: Discord.Message): Promise<Discord.EmbedBuilder[]> {
        const voice_channel = message.member?.voice.channel;
        if (voice_channel && voice_channel instanceof Discord.VoiceChannel) {
            this.request_voice_connection(voice_channel);
        } else {
            return [new Discord.EmbedBuilder()
                .setColor("Red")
                .setDescription("Please join a voice channel.")];
        }

        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message)) {
                return [new Discord.EmbedBuilder()
                    .setColor("Red")
                    .setDescription("I'm already in a voice channel!")];
            }

            return [new Discord.EmbedBuilder()
                .setColor("Green")
                .setDescription("Joined channel!")];
        }

        return [new Discord.EmbedBuilder()];
    }

    async command_leave(message: Discord.Message): Promise<Discord.EmbedBuilder[]> {
        const embed = new Discord.EmbedBuilder();

        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            this.audio_connection.destroy();
            this.audio_connection = null;

            embed.setColor("Red");
            embed.setDescription("bai 👋🏻");
        }

        return [embed];
    }

    async command_loop(message: Discord.Message): Promise<Discord.EmbedBuilder[]> {
        const embed = new Discord.EmbedBuilder();

        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            this.audio_connection.loop = !this.audio_connection.loop;

            embed.setColor("Blue");
            if (this.audio_connection.loop)
                embed.setDescription("Now looping the current track");
            else
                embed.setDescription("Stopped looping the current track");
        }

        return [embed];
    }

    async command_lyrics(message: Discord.Message, args: string[]): Promise<Discord.EmbedBuilder[]> {
        const embeds = [new Discord.EmbedBuilder()];

        let title;
        if (args.length > 0) {
            title = args.join(" ");
        } else if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            const resource = this.audio_connection.now_playing_resource();
            if (!resource)
                return embeds;

            title = resource.metadata.title;
            title = title.replace(/\((.*)\)|feat(\.)*|ft(\.)*|video*|lyric(s)*/gi, "").trim();
        } else {
            return embeds;
        }

        const lyrics = await find_lyrics(title);
        if (lyrics instanceof Error) {
            console.error(lyrics);
            embeds[0].setColor("Red");
            embeds[0].setDescription(lyrics.message);
            return embeds;
        }

        embeds[0].setColor("Blue");
        embeds[0].setTitle("Lyrics");

        const embed_threshold = 4096;
        let lyric_content = lyrics.content;
        if (lyric_content.length < embed_threshold) {
            embeds[0].setDescription(lyric_content);
        } else {
            while (lyric_content.length > embed_threshold) {
                for (let i = embed_threshold; i >= 0; i -= 1) {
                    if (lyric_content[i] === "\n" && lyric_content.slice(0, i).trim() !== "") {
                        embeds[embeds.length - 1].setColor("Blue");
                        embeds[embeds.length - 1].setDescription(lyric_content.slice(0, i));
                        embeds.push(new Discord.EmbedBuilder());
                        lyric_content = lyric_content.slice(i);
                    }
                }
            }
            embeds.splice(embeds.length - 1, embeds.length);
        }
        embeds[embeds.length - 1].setFooter({ "text": lyrics.url });

        return embeds;
    }

    async command_move(message: Discord.Message, args: string[]): Promise<Discord.EmbedBuilder[]> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            return [this.audio_connection.move(args[0], args[1])];
        }

        return [new Discord.EmbedBuilder()];
    }

    async command_pause(message: Discord.Message): Promise<Discord.EmbedBuilder[]> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            return [this.audio_connection.pause()];
        }

        return [new Discord.EmbedBuilder()];
    }

    async command_play(message: Discord.Message, args: string[]): Promise<Discord.EmbedBuilder[]> {
        const voice_channel = message.member?.voice.channel;
        if (voice_channel && voice_channel instanceof Discord.VoiceChannel) {
            this.request_voice_connection(voice_channel);
        } else {
            return [new Discord.EmbedBuilder()
                .setColor("Red")
                .setDescription("Please join a voice channel.")];
        }

        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            const result = await this.audio_connection.play(args);
            if (result)
                return [result];
        }

        return [new Discord.EmbedBuilder()];
    }

    async command_config(_message: Discord.Message, args: string[]): Promise<Discord.EmbedBuilder[]> {
        const embed = new Discord.EmbedBuilder();
        embed.setColor("Green");

        if (!args[0]) {
            let config_options = ``;
            for (const [option, data] of Object.entries(GuildConnection.config_options)) {
                // @ts-expect-error: This always works, because option is indexed from config_options
                config_options += `**${option}**: *${data.type}* - ${data.description} (current: ${this.config[option]}, default: ${GuildConnection.default_config[option]}${data.options ? ", options: [" + data.options + "]" : ""})\n`;
            }
            embed.setColor("Blue")
            embed.setTitle("Configuration")
            embed.setDescription(config_options)
            embed.setFooter({ text: `For example: config prefix %` });
            return [embed];
        }

        if (!Object.keys(GuildConnection.config_options).includes(args[0])) {
            embed.setColor("Red");
            embed.setDescription(`Config option: *${args[0]}*, not recognized, invoke without arguments for options`);
            return [embed];
        }

        // @ts-expect-error: This always works, because this was verified as valid in the lines above
        const data = GuildConnection.config_options[args[0]];
        // eslint-disable-next-line
        let value: any = args[1];
        try {
            if (!value) throw new Error("provided config value is empty");
            switch (data.type) {
                case "string":
                    if (data.options && !data.options.includes(value)) throw new Error(`provided option "${value}" not in allowed list`);
                    break;
                case "number":
                    value = parseInt(value);
                    if (isNaN(value)) throw new Error("provided config value unable to be parsed to int");
                    break;
            }
        } catch (error) {
            console.error(error);
            embed.setColor("Red");
            embed.setDescription(`Invalid value: *${value}*, for configuration option: *${args[0]}*. Invoke without arguments for options and proper usage`);
            return [embed];
        }

        // @ts-expect-error: This always works, because this was verified as valid
        this.config[args[0]] = value;
        this.set_config();
        embed.setDescription(`Updated *${args[0]}* to: *${value}*.`);
        return [embed];
    }

    async command_queue(message: Discord.Message, args: string[]): Promise<Discord.EmbedBuilder[]> {
        const embed = new Discord.EmbedBuilder();

        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            const page = args[0];
            const queue_obj = this.audio_connection.stringify_queue(page);
            const now_playing = this.audio_connection.now_playing();

            embed.setColor("Blue");
            if (now_playing) {
                embed.setTitle("Now Playing");
                embed.setDescription(now_playing);

                if (queue_obj) {
                    embed.addFields([{ name: "Coming up", value: queue_obj.queue }]);
                    embed.setFooter({ text: `Page ${queue_obj.page + 1} / ${queue_obj.pages}` });
                }
            } else if (queue_obj) {
                embed.setTitle("Coming up");
                embed.setDescription(queue_obj.queue);
                embed.setFooter({ text: `Page ${queue_obj.page + 1} / ${queue_obj.pages}` });
            }
        }

        return [embed];
    }

    command_queue_callback(message: Discord.Message) {
        if (!this.audio_connection || !message.embeds[0].data.title)
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
            ["🔄", "refresh"],
        ]);

        const filter = (_: Discord.MessageReaction, user: Discord.User) => user.id !== Bot.the().client.user?.id;
        const reactionCollector = message.createReactionCollector({ filter });
        reactionCollector.on("collect", async (reaction) => {
            reaction.users.fetch().then((users) => {
                for (const [id, user] of users) {
                    if (id !== Bot.the().client.user?.id)
                        reaction.users.remove(user);
                }
            });

            if (!reaction.emoji.name)
                return;

            const footer = message.embeds[0].footer?.text.split(" ");
            let page, pages;
            if (footer) {
                page = parseInt(footer[1]);
                pages = parseInt(footer[3]);
            }

            const edit = async (page: string) => {
                const embed = (await this.command_queue(message, [page]))[0];

                if (!embed.data.description) {
                    embed.setColor("Red");
                    embed.setDescription("Not currently playing.");
                }

                message.edit({ embeds: [embed] });
            }

            switch (emojis.get(reaction.emoji.name)) {
                case "first": edit("1"); break;
                case "previous": edit(page ? (page - 1).toString() : "1"); break;
                case "next": edit(page ? (page + 1).toString() : "1"); break;
                case "last": edit(pages ? pages.toString() : "1"); break;
                case "shuffle":
                    if (this.audio_connection)
                        this.audio_connection.shuffle();
                    edit(page ? page.toString() : "1");
                    break;
                case "refresh": edit(page ? page.toString() : "1"); break;
            }
        });

        for (const emoji of emojis.keys())
            message.react(emoji).catch(error => console.error(error));
    }

    async command_seek(message: Discord.Message, args: string[]): Promise<Discord.EmbedBuilder[]> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            return [this.audio_connection.seek(args[0])];
        }

        return [new Discord.EmbedBuilder()];
    }

    async command_skip(message: Discord.Message, args: string[]): Promise<Discord.EmbedBuilder[]> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            return [this.audio_connection.skip(args[0])];
        }

        return [new Discord.EmbedBuilder()];
    }

    async command_remove(message: Discord.Message, args: string[]): Promise<Discord.EmbedBuilder[]> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            return [this.audio_connection.remove(args[0])];
        }

        return [new Discord.EmbedBuilder()];
    }

    async command_resume(message: Discord.Message): Promise<Discord.EmbedBuilder[]> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            return [this.audio_connection.resume()];
        }

        return [new Discord.EmbedBuilder()];
    }

    async command_shuffle(message: Discord.Message): Promise<Discord.EmbedBuilder[]> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            return [this.audio_connection.shuffle()];
        }

        return [new Discord.EmbedBuilder()];
    }

    async command_unknown(): Promise<Discord.EmbedBuilder[]> {
        return [new Discord.EmbedBuilder()
            .setColor("Red")
            .setDescription(`Unknown command, use \`${this.config.prefix}help\` for a list of commands.`)];
    }

    async command_volume(message: Discord.Message, args: string[]): Promise<Discord.EmbedBuilder[]> {
        if (this.audio_connection) {
            if (!this.audio_connection.check_voice_channel(message))
                return [this.audio_connection.wrong_voice_channel()];

            return [this.audio_connection.set_volume(args[0])];
        }

        return [new Discord.EmbedBuilder()];
    }
}
