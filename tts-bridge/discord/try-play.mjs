import { readFile } from "node:fs/promises";
import { getCiphers } from "node:crypto";
import { Readable } from "node:stream";
import { toDiscordPcm } from "./pcm.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "DISCORD_BOT_TOKENを設定して実行してください。\nnode discord/try-play.mjs                チャンネル一覧\nnode discord/try-play.mjs CHANNEL_ID WAV 再生して退出\nnode discord/try-play.mjs --check        依存・暗号化だけ確認",
  );
} else {
  let client, connection, player, subscription;
  let stopping = false;
  const cleanup = () => {
    if (stopping) return;
    stopping = true;
    player?.stop(true);
    subscription?.unsubscribe();
    if (connection && connection.state.status !== "destroyed")
      connection.destroy();
    client?.destroy();
  };
  const signal = () => {
    cleanup();
    process.exit(130);
  };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  // Do not print raw library errors: authentication errors can contain secrets.
  let stage = "依存パッケージの読み込み（cd discord && npm ci）";
  const token = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  try {
    const d = await import("discord.js"),
      v = await import("@discordjs/voice");
    await import("@snazzah/davey");
    const { default: OpusScript } = await import("opusscript");
    const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    encoder.encode(Buffer.alloc(960 * 4), 960);
    encoder.delete();
    if (!getCiphers().includes("aes-256-gcm")) throw new Error("暗号化");
    console.log(v.generateDependencyReport());
    console.log("DAVEロード / Opusエンコード / AES-256-GCM: OK");
    if (!args.includes("--check")) {
      stage = "引数・トークンの確認（--helpを参照）";
      if (
        !token ||
        /\s/.test(token) ||
        token.length > 200 ||
        !(
          args.length === 0 ||
          (args.length === 2 && /^\d{17,20}$/.test(args[0]))
        )
      )
        throw new Error("引数");
      const pcm = args.length ? toDiscordPcm(await readFile(args[1])) : null;
      if (pcm && (!pcm.length || pcm.length > 48000 * 4 * 120))
        throw new Error("WAVは120秒以内");
      client = new d.Client({
        intents: [
          d.GatewayIntentBits.Guilds,
          d.GatewayIntentBits.GuildVoiceStates,
        ],
      });
      client.on("error", () => console.error("Discord Gatewayエラー"));
      stage = "ログイン";
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          done(new Error("timeout"));
        }, 30000);
        const ready = () => done();
        const done = (error) => {
          clearTimeout(timer);
          client.off(d.Events.ClientReady, ready);
          error ? reject(error) : resolve();
        };
        client.once(d.Events.ClientReady, ready);
        client.login(token).catch(done);
      });
      console.log(`Bot: ${client.user.tag}`);
      console.log(
        `招待URL: https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=3146752`,
      );
      const channels = [];
      stage = "チャンネル一覧の取得";
      for (const guild of [...client.guilds.cache.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        await guild.channels.fetch();
        const me = await guild.members.fetchMe();
        for (const ch of [...guild.channels.cache.values()]
          .filter((ch) => ch.type === d.ChannelType.GuildVoice)
          .sort((a, b) => a.rawPosition - b.rawPosition)) {
          const allowed =
            ch
              .permissionsFor(me)
              ?.has([
                d.PermissionFlagsBits.ViewChannel,
                d.PermissionFlagsBits.Connect,
                d.PermissionFlagsBits.Speak,
              ]) ?? false;
          channels.push({ ch, allowed });
          console.log(
            `${guild.name} / ${ch.name}: ${ch.id}${allowed ? "" : "（権限がありません）"}`,
          );
        }
      }
      if (!channels.length)
        console.log(
          "ボイスチャンネルがありません。Botをあなたのserverに招待してください。",
        );
      if (pcm) {
        stage = "チャンネルの選択・権限確認";
        const selected = channels.find(({ ch }) => ch.id === args[0]);
        if (!selected?.allowed) throw new Error("チャンネル");
        const { ch } = selected;
        stage = "ボイス接続";
        connection = v.joinVoiceChannel({
          guildId: ch.guild.id,
          channelId: ch.id,
          adapterCreator: ch.guild.voiceAdapterCreator,
          selfDeaf: true,
          selfMute: false,
        });
        connection.on("error", () => console.error("ボイス接続エラー"));
        connection.on("stateChange", (_old, next) =>
          console.log(
            `Voice: ${next.status}${next.closeCode ? ` (close code ${next.closeCode})` : ""}`,
          ),
        );
        await v.entersState(connection, v.VoiceConnectionStatus.Ready, 30000);
        player = v.createAudioPlayer();
        player.on("error", () => console.error("音声再生エラー"));
        subscription = connection.subscribe(player);
        if (!subscription) throw new Error("購読");
        stage = "WAV再生";
        await new Promise((resolve, reject) => {
          const done = (error) => {
            clearTimeout(timer);
            player.off(v.AudioPlayerStatus.Idle, idle);
            player.off("error", fail);
            error ? reject(error) : resolve();
          };
          const idle = () => done(),
            fail = (error) => done(error);
          const timer = setTimeout(() => done(new Error("timeout")), 130000);
          player.once(v.AudioPlayerStatus.Idle, idle);
          player.once("error", fail);
          try {
            player.play(
              v.createAudioResource(Readable.from([pcm]), {
                inputType: v.StreamType.Raw,
              }),
            );
          } catch (error) {
            done(error);
          }
        });
        console.log(
          "送信完了。Discordで実際に音が聞こえたことを確認してください。",
        );
      }
    }
  } catch {
    console.error(
      `失敗: ${stage}。トークン・権限・ネットワーク・WAV形式を確認してください。`,
    );
    process.exitCode = 1;
  } finally {
    cleanup();
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
  }
}
