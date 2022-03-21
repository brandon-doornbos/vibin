import * as Discord from "discord.js";
import { GuildConnection } from "./guild_connection.js";

enum Command {
    // FIXME: Bind,
    Clear,
    Help,
    // FIXME: Join
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
    private command_cache: Map<string, Command>;

    static instance: Bot;

    static the(): Bot {
        if (!Bot.instance) {
            Bot.instance = new Bot(process.argv[2]);
        }

        return Bot.instance;
    }

    private constructor(token: string) {
        this.connections = new Map();
        this.command_cache = this.build_command_cache();
        this.command_cache.set("p", Command.Play);

        this.client = new Discord.Client({
            intents: [
                Discord.Intents.FLAGS.GUILD_VOICE_STATES,
                Discord.Intents.FLAGS.GUILD_MESSAGES,
                Discord.Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
                Discord.Intents.FLAGS.GUILDS,
            ]
        });

        this.client.once("ready", (client) => console.log(`${client.user?.tag} ready!`));
        this.client.on("error", (error) => console.warn(error));
        this.client.on("messageCreate", (message) => this.on_message_create(message));

        this.client.login(token);
    }

    private build_command_cache(): Map<string, Command> {
        let cache = new Map();

        for (let command in Command) {
            if (parseInt(command) >= 0 || command === "Unknown")
                continue;

            let entry = "";
            for (let letter of command.toLowerCase()) {
                entry += letter;
                if (!cache.get(entry))
                    cache.set(entry, Command[command]);
            }
        }

        return cache;
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

        const rest = message.content.slice(connection.prefix.length);
        const parsed_message = this.parse_message(rest);
        const command = Command[parsed_message.command].toLowerCase();
        // @ts-ignore
        let embed = await connection[`command_${command}`](message, parsed_message.args);
        if (!embed.description && embed.fields.length <= 0) {
            embed.setColor("#FF0000");
            embed.setDescription("Not currently playing.");
        }
        const result = await message.reply({ embeds: [embed] });
        // @ts-ignore
        if (connection[`command_${command}_callback`]) {
            // @ts-ignore
            connection[`command_${command}_callback`](result);
        }
    }

    parse_message(content: string): { command: Command, args: string[] } {
        const unknown = { command: Command.Unknown, args: [] };

        let args = content.split(' ');

        let first_arg = args.shift();
        if (!first_arg)
            return unknown;

        let command = this.command_cache.get(first_arg);
        if (command === undefined)
            return unknown;

        return { command, args };
    }
}

void Bot.the();
