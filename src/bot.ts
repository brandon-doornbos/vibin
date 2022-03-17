import * as Discord from "discord.js";
import { GuildConnection } from "./guild_connection.js";

enum Command {
    // FIXME: Bind,
    Clear,
    Help,
    Leave,
    Move,
    Pause,
    Play,
    Prefix,
    Queue,
    // FIXME: Seek,
    Skip,
    Remove,
    Resume,
    Shuffle,
    Unknown
}

export class Bot {
    private connections: Map<Discord.Snowflake, GuildConnection>;
    client: Discord.Client;
    // private message_type_cache: Map<MessageType, string[]>;

    static instance: Bot;

    static the(): Bot {
        if (!Bot.instance) {
            Bot.instance = new Bot(process.argv[2]);
        }

        return Bot.instance;
    }

    private constructor(token: string) {
        this.connections = new Map();
        // this.message_type_cache = new Map();
        // for (let key of Object.keys(MessageType).filter(x => !(parseInt(x) >= 0)).map((x) => x.toLowerCase())) {

        //     console.log(key);
        // }

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
        if (!message.guildId || !(message.channel instanceof Discord.TextChannel))
            return;

        let connection = this.connections.get(message.guildId);
        if (!connection) {
            connection = new GuildConnection(message.channel);
            this.connections.set(message.guildId, connection);
        }

        const prefix = message.content.slice(0, connection.prefix.length);
        if (prefix !== connection.prefix)
            return;

        let parsed_message = this.parse_message(message);
        // @ts-ignore
        connection[`command_${Command[parsed_message.command].toLowerCase()}`](parsed_message.args);

        if (!message.guild || message.member?.id === this.client.user?.id || message.member?.user.bot) return;

        // FIXME: these checks were removed, see if they are necessary
        // let server_connection = this.connections.get(message.guild.id);
        // if (server_connection && server_connection.destroyed) {
        //     this.connections.delete(message.guild.id);
        //     server_connection = undefined;
        // }

        // if (!server_connection && message.member instanceof Discord.GuildMember) {
        //     if (
        //         message.member.voice.channel
        //         && message.member.voice.channel instanceof Discord.VoiceChannel
        //         && message.channel instanceof Discord.TextChannel
        //     ) {
        //         const voiceChannel = message.member.voice.channel;
        //         server_connection = new GuildConnection(message.channel, voiceChannel,
        //             DiscordVoice.joinVoiceChannel({
        //                 channelId: voiceChannel.id,
        //                 guildId: voiceChannel.guild.id,
        //                 adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        //                 selfDeaf: true,
        //             }), this.client
        //         );
        //         server_connection.voice.connection.on("error", console.warn);
        //         this.connections.set(message.guild?.id, server_connection);
        //     } else {
        //         message.reply("Please join a voice channel.");
        //         return;
        //     }
        // }

        // if (!server_connection) {
        //     message.reply("wtf");
        //     return;
        // }

        // FIXME: check this for voice required commands etc., maybe define it in a struct for each command
        // if (message.member?.voice.channel !== this.audio.channel) {
        //     await message.reply("Join the correct voice channel and then try that again!");
        //     console.log("plz join correct channel");
        //     return;
        // }
    }

    parse_message(message: Discord.Message): { command: Command, args: string[] } {
        // FIXME: actually parse command and args
        // message.content.slice(connection.prefix.length).split(" ")[0]

        return { command: Command.Unknown, args: [] };
    }

    static async not_playing(message: Discord.Message) {
        const embed = new Discord.MessageEmbed()
            .setColor("#FF0000")
            .addField("Not currently playing", "🤷🏻");

        message.reply({ embeds: [embed] });
    }
}

void Bot.the();
