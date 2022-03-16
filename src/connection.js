import { accessSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import {
    AudioPlayerStatus,
    createAudioPlayer,
    entersState,
    VoiceConnectionDisconnectReason,
    VoiceConnectionStatus,
} from '@discordjs/voice';
import { promisify } from 'util';
const wait = promisify(setTimeout);

export class GuildConnection {
    constructor(botChannel, voiceChannel, voiceConnection, clientId) {
        this.botChannel = botChannel;
        this.voiceChannel = voiceChannel;
        this.voiceConnection = voiceConnection;
        this.clientId = clientId;
        this.audioPlayer = createAudioPlayer();
        this.queue = [];
        this.activeQueueMessage = undefined;
        this.queueLock = false;
        this.readyLock = false;
        this.destroyed = false;

        this.prefix = '$';
        let prefix = undefined;
        try {
            prefix = readFileSync(`prefixes/${this.clientId}/${this.botChannel.guild?.id}`, "utf8");
        } catch { }
        if (prefix) {
            this.prefix = prefix.trim();
        }

        this.voiceConnection.on('stateChange', async (_, newState) => {
            switch (newState.status) {
                case VoiceConnectionStatus.Disconnected: {
                    if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
                        /*
                            If the WebSocket closed with a 4014 code, this means that we should not manually attempt to reconnect,
                            but there is a chance the connection will recover itself if the reason of the disconnect was due to
                            switching voice channels. This is also the same code for the bot being kicked from the voice channel,
                            so we allow 5 seconds to figure out which scenario it is. If the bot has been kicked, we should destroy
                            the voice connection.
                        */
                        try { // Probably moved voice channel
                            await entersState(this.voiceConnection, VoiceConnectionStatus.Connecting, 5_000);
                        } catch { // Probably removed from voice channel
                            this.voiceConnection.destroy();
                            this.botChannel.send("y u kick :(");
                        }
                    } else if (this.voiceConnection.rejoinAttempts < 5) { // recoverable case with < 5 attemps, reconnect
                        await wait((this.voiceConnection.rejoinAttempts + 1) * 5_000);
                        this.voiceConnection.rejoin();
                    } else { // may be recoverable but > 5 attemps, destroy
                        this.voiceConnection.destroy();
                    }
                    break;
                }
                case VoiceConnectionStatus.Destroyed: {
                    this.stop();
                    this.destroyed = true;
                    break;
                }
                case VoiceConnectionStatus.Connecting: case VoiceConnectionStatus.Signalling: {
                    if (this.readyLock) break;
                    /*
                        In the Signalling or Connecting states, we set a 20 second time limit for the connection to become ready
                        before destroying the voice connection. This stops the voice connection permanently existing in one of these
                        states.
                    */
                    this.readyLock = true;
                    try {
                        await entersState(this.voiceConnection, VoiceConnectionStatus.Ready, 20_000);
                    } catch {
                        if (this.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) this.voiceConnection.destroy();
                    } finally {
                        this.readyLock = false;
                    }
                    break;
                }
                case VoiceConnectionStatus.Ready: {
                    this.voiceChannel = this.voiceConnection.packets.state.channel_id;
                }
            }
        });

        this.audioPlayer.on('stateChange', (oldState, newState) => {
            if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) { // now idle, play next track if available
                oldState.resource.metadata.onFinish();
                void this.processQueue();
            } else if (newState.status === AudioPlayerStatus.Playing) { // entered playing state, started next track
                newState.resource.metadata.onStart(this.botChannel);
            }
        });

        this.audioPlayer.on('error', (error) => error.resource.metadata.onError(error, this.botChannel));

        voiceConnection.subscribe(this.audioPlayer);
    }

    update_prefix(newPrefix) {
        this.prefix = newPrefix;
        try {
            accessSync(`prefixes/${this.clientId}`);
        } catch {
            mkdirSync(`prefixes/${this.clientId}`);
        }
        writeFileSync(`prefixes/${this.clientId}/${this.botChannel.guild?.id}`, this.prefix);
    }

    enqueue(track) {
        this.queue.push(track);
        void this.processQueue();
    }

    stop() {
        this.queueLock = true;
        this.queue = [];
        this.audioPlayer.stop(true);
    }

    async processQueue() {
        if (this.queueLock || this.audioPlayer.state.status !== AudioPlayerStatus.Idle || this.queue.length === 0)
            return;

        this.queueLock = true;

        const nextTrack = this.queue.shift();
        try {
            // Attempt to convert the Track into an AudioResource (i.e. start streaming the video)
            const resource = await nextTrack.createAudioResource();
            this.audioPlayer.play(resource);
            this.queueLock = false;
        } catch (error) {
            // If an error occurred, try the next item of the queue instead
            nextTrack.onError(error, this.botChannel);
            this.queue.unshift(nextTrack);
            this.queueLock = false;
            return this.processQueue();
        }
    }
}
