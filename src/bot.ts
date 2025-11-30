import * as Discord from "discord.js";
import { GuildConnection } from "./guild_connection.js";
import tokens from "./config.json" assert { type: "json" };
import package_info from "../package.json" assert { type: "json" };

enum Command {
    Bind,
    Clear,
    Help,
    Join,
    Leave,
    Loop,
    Lyrics,
    Move,
    Pause,
    Play,
    Config,
    Queue,
    Seek,
    Skip,
    Remove,
    Resume,
    Shuffle,
    Unknown,
    Volume,
}

export class Bot {
    private connections: Map<Discord.Snowflake, GuildConnection>;
    client: Discord.Client;
    private command_cache: Map<string, Command>;

    static instance: Bot;

    static the(): Bot {
        if (!Bot.instance)
            Bot.instance = new Bot(process.argv[2] || tokens.vibin);

        return Bot.instance;
    }

    private constructor(token: string) {
        console.log("Initializing Vibin v" + package_info.version);

        this.connections = new Map();
        this.command_cache = this.build_command_cache();
        this.command_cache.set("p", Command.Play);
        this.command_cache.set("s", Command.Skip);

        this.client = new Discord.Client({
            intents: [
                Discord.GatewayIntentBits.GuildVoiceStates,
                Discord.GatewayIntentBits.GuildMessages,
                Discord.GatewayIntentBits.GuildMessageReactions,
                Discord.GatewayIntentBits.Guilds,
                Discord.GatewayIntentBits.MessageContent,
            ],
        });

        this.client.once("ready", (client) => this.on_ready(client));
        this.client.on("error", (error) => console.warn(error));
        this.client.on("messageCreate", async (message) => this.on_message_create(message));

        this.client.login(token);
    }

    on_ready(client: Discord.Client) {
        const user = client.user;
        if (!user)
            return;

        console.log(`Ready, with tag: ${user.tag}`);
        user.setPresence({ activities: [{ type: Discord.ActivityType.Listening, name: `@${user.username} help` }] });
    }

    private build_command_cache(): Map<string, Command> {
        const cache = new Map();

        for (const command in Command) {
            if (parseInt(command) >= 0 || command === "Unknown")
                continue;

            let entry = "";
            for (const letter of command.toLowerCase()) {
                entry += letter;
                if (!cache.get(entry))
                    cache.set(entry, Command[command]);
            }
        }

        return cache;
    }

    async on_message_create(message: Discord.Message) {
        if (!message.guildId || !(message.channel instanceof Discord.TextChannel) || message.author.id === this.client.user?.id)
            return;

        let connection = this.connections.get(message.guildId);
        if (!connection) {
            connection = new GuildConnection(message.channel);
            this.connections.set(message.guildId, connection);
        }

        let content = "";
        if (
            message.content.startsWith(`<@${this.client.user?.id}>`)
            || message.content.startsWith(`<@!${this.client.user?.id}>`)
        ) {
            content = message.content.split(">").slice(1).join(">");
            if (content[0] === " ") content = content.slice(1);
        } else {
            if (message.content.slice(0, connection.config.prefix.length) !== connection.config.prefix)
                return;
            content = message.content.slice(connection.config.prefix.length);
        }

        connection.text_channel = message.channel;

        const parsed_message = this.parse_message(content);
        const command = Command[parsed_message.command].toLowerCase();
        const embeds = await connection[`command_${command}`](message, parsed_message.args);
        for (const embed of embeds) {
            if (!embed.data.description && !embed.data.fields) {
                embed.setColor("Red");
                embed.setDescription("Not currently playing.");
            }
            const result = await message.reply({ embeds: [embed] });
            if (connection[`command_${command}_callback`]) {
                connection[`command_${command}_callback`](result);
            }
        }
    }

    parse_message(content: string): { command: Command, args: string[] } {
        const unknown = { command: Command.Unknown, args: [] };

        const args = content.split(" ");

        const first_arg = args.shift();
        if (!first_arg)
            return unknown;

        const command = this.command_cache.get(first_arg.toLowerCase());
        if (command === undefined)
            return unknown;

        return { command, args };
    }
}

void Bot.the();
