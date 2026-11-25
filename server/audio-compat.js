// Server-side audio compatibility for direct media files.
//
// Browsers decode AAC, MP3 and Opus, but not the AC-3/E-AC-3 (Dolby) or DTS
// audio that many new releases carry. For such a file the player keeps reading
// video from the original and reads audio from a virtual WAV file served here:
// stereo 48 kHz PCM has a fixed byte rate, so every byte range maps to
// an exact time and FFmpeg decodes just that part of the source on demand.
// Seeking stays cheap and no converted copy is stored. FFmpeg reaches the source
// only through a loopback proxy that applies TesPlay's remote-address checks.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const SAMPLE_RATE = 48000;
const CHANNELS = 2;
export const HEADER_BYTES = 44;
// Both formats have a fixed byte rate. 16-bit PCM is the default; 8-bit μ-law
// is for browsers whose WebCodecs lacks PCM (μ-law has been there since
// Chrome 93, below TesPlayer's WebCodecs baseline). μ-law silence is 0xFF.
const FORMATS = {
  pcm: { tag: 1, bytes: 2, codec: "pcm_s16le", muxer: "s16le", silence: Buffer.alloc(64 * 1024) },
  ulaw: { tag: 7, bytes: 1, codec: "pcm_mulaw", muxer: "mulaw", silence: Buffer.alloc(64 * 1024, 0xff) },
};
export const formatName = (name) => (Object.hasOwn(FORMATS, name) ? name : "pcm");
const frameBytes = (format) => CHANNELS * FORMATS[format].bytes;
// The RIFF size fields are 32-bit; six hours of 48 kHz stereo PCM fit.
const MAX_SECONDS = 6 * 3600;
// Real media containers only: an HLS playlist would make FFmpeg fetch other
// addresses itself instead of going through the loopback proxy.
const DEMUXERS = "mov,matroska,mpegts,avi";
/** Canonical 44-byte header of a stereo 48 kHz WAV file. */
export function wavHeader(dataBytes, format = "pcm") {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(FORMATS[format].tag, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * frameBytes(format), 28);
  header.writeUInt16LE(frameBytes(format), 32);
  header.writeUInt16LE(FORMATS[format].bytes * 8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function probeArgs(input) {
  return [
    "-v", "error", "-protocol_whitelist", "http,tcp", "-format_whitelist", DEMUXERS,
    "-show_entries", "format=duration,start_time:stream=codec_name,channels:stream_tags=language,title:stream_disposition=default",
    "-select_streams", "a", "-of", "json", input,
  ];
}

/** Decode one audio stream from `seconds` (relative to the source's start) to raw samples. */
export function decodeArgs(input, seconds, stream, format = "pcm") {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-protocol_whitelist", "http,tcp", "-format_whitelist", DEMUXERS,
    "-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "5",
    ...(seconds > 0 ? ["-ss", seconds.toFixed(6)] : []),
    "-i", input,
    "-map", `0:a:${stream}`, "-vn", "-sn", "-dn",
    // Pad gaps and late starts with silence so byte offsets keep matching time.
    "-af", "aresample=async=1:first_pts=0",
    "-ac", String(CHANNELS), "-ar", String(SAMPLE_RATE), "-c:a", FORMATS[format].codec, "-f", FORMATS[format].muxer, "pipe:1",
  ];
}

/** Choose the 0-based audio stream: the player's 1-based track number, else the default track. */
export function chooseStream(streams, trackNumber) {
  const requested = Number(trackNumber) - 1;
  if (Number.isInteger(requested) && requested >= 0 && requested < streams.length) return requested;
  return Math.max(0, streams.findIndex((s) => Number(s?.disposition?.default) === 1));
}

function* silence(count, format) {
  const block = FORMATS[format].silence;
  for (let left = count; left > 0; left -= block.length) yield block.subarray(0, Math.min(left, block.length));
}

// Serves registered sources on 127.0.0.1 under unguessable paths, so FFmpeg can
// read with HTTP ranges while every upstream request still goes through
// requestRemote's DNS pinning, redirect and private-address checks.
function createLoopback(requestRemote) {
  const sources = new Map();
  const server = createServer(async (req, res) => {
    const source = sources.get(String(req.url).slice(1));
    if (!source || !["GET", "HEAD"].includes(req.method)) return res.writeHead(404).end();
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    try {
      const upstream = await requestRemote(source.url, {
        method: req.method,
        headers: { ...(await source.headers()), ...(req.headers.range ? { Range: req.headers.range } : {}) },
        allowedPrivateHosts: source.allowedPrivateHosts,
        timeout: 45000,
        signal: controller.signal,
      });
      const headers = {};
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"])
        if (upstream.headers[name]) headers[name] = upstream.headers[name];
      res.writeHead(upstream.statusCode, headers);
      if (req.method === "HEAD") {
        upstream.destroy();
        return res.end();
      }
      res.once("close", () => upstream.destroy());
      upstream.once("error", () => res.destroy());
      upstream.pipe(res);
    } catch {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    }
  });
  server.unref();
  let port;
  return {
    async open(source) {
      port ??= new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
      const secret = randomBytes(24).toString("base64url");
      sources.set(secret, source);
      return { url: `http://127.0.0.1:${await port}/${secret}`, close: () => sources.delete(secret) };
    },
    close: () => server.close(),
  };
}

export function createAudioCompat({
  requestRemote,
  parseRange,
  providerError,
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
  ffprobe = process.env.FFPROBE_PATH || "ffprobe",
  spawnProcess = spawn,
  maxProcesses = 6,
}) {
  const loopback = createLoopback(requestRemote);
  let running = 0;
  const unavailable = () => providerError("Audio conversion is unavailable: FFmpeg is not installed on the server.", 501);

  function probeSource(args) {
    return new Promise((resolve, reject) => {
      const child = spawnProcess(ffprobe, args, { stdio: ["ignore", "pipe", "ignore"] });
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error.code === "ENOENT" ? unavailable() : error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
        else reject(providerError("The audio of this title could not be read for conversion.", 502));
      });
    });
  }

  /** Read the source's audio layout: which stream to convert and how long the WAV is. */
  async function probe(source, trackNumber, requestedFormat) {
    const format = formatName(requestedFormat);
    const input = await loopback.open(source);
    let info;
    try {
      info = JSON.parse(await probeSource(probeArgs(input.url)));
    } catch (error) {
      if (error.status) throw error;
      throw providerError("The audio of this title could not be read for conversion.", 502);
    } finally {
      input.close();
    }
    const streams = Array.isArray(info?.streams) ? info.streams : [];
    if (!streams.length) throw providerError("This title has no audio track to convert.", 422);
    const startTime = Number(info.format?.start_time) || 0;
    const end = startTime + Number(info.format?.duration);
    if (!(end > 0) || end > MAX_SECONDS)
      throw providerError("The audio of this title cannot be converted because its length is unknown.", 422);
    const stream = chooseStream(streams, trackNumber);
    return {
      format,
      stream,
      startTime,
      dataBytes: Math.ceil(end * SAMPLE_RATE) * frameBytes(format),
      codec: String(streams[stream]?.codec_name || "unknown").slice(0, 32),
    };
  }

  // WAV time 0 is the source timeline's 0. Bytes before the source's first
  // sample are silence; bytes after its audio ends are silence too.
  async function* body(item, start, end, stop) {
    const bytes = frameBytes(item.format);
    let left = end - start + 1;
    if (start < HEADER_BYTES) {
      const part = wavHeader(item.dataBytes, item.format).subarray(start, Math.min(HEADER_BYTES, end + 1));
      left -= part.length;
      yield part;
    }
    const offset = Math.max(0, start - HEADER_BYTES);
    const frame = Math.floor(offset / bytes);
    let skip = offset - frame * bytes;
    const seconds = frame / SAMPLE_RATE - item.startTime;
    const lead = Math.min(left, seconds < 0 ? Math.round(-seconds * SAMPLE_RATE) * bytes - skip : 0);
    if (lead > 0) {
      yield* silence(lead, item.format);
      left -= lead;
      skip = 0;
    }
    if (left <= 0 || stop.aborted) return;
    const input = await loopback.open(item.source);
    running++;
    const child = spawnProcess(ffmpeg, decodeArgs(input.url, Math.max(0, seconds), item.stream, item.format), { stdio: ["ignore", "pipe", "pipe"] });
    // Stop at once when the player drops this read, even while FFmpeg waits on the source.
    const kill = () => child.kill("SIGKILL");
    stop.addEventListener("abort", kill, { once: true });
    let failure = "";
    child.stderr.on("data", (chunk) => {
      if (failure.length < 500) failure += chunk;
    });
    const exit = new Promise((resolve) => {
      child.once("error", (error) => resolve(error.code === "ENOENT" ? "missing" : -1));
      child.once("close", resolve);
    });
    try {
      for await (let chunk of child.stdout) {
        if (skip) {
          const cut = Math.min(skip, chunk.length);
          chunk = chunk.subarray(cut);
          skip -= cut;
        }
        if (chunk.length > left) chunk = chunk.subarray(0, left);
        left -= chunk.length;
        if (chunk.length) yield chunk;
        if (left <= 0) return;
      }
      const code = await exit;
      if (stop.aborted) return;
      if (code === "missing") throw unavailable();
      if (code !== 0) {
        console.warn("TesPlay audio conversion failed:", failure.split("\n")[0].replace(/https?:\/\/\S+/g, "<source>").slice(0, 200));
        throw providerError("Audio conversion stopped.", 502);
      }
      yield* silence(left, item.format);
    } finally {
      stop.removeEventListener("abort", kill);
      kill();
      running--;
      input.close();
    }
  }

  /** Serve a byte range of the virtual WAV file described by `item`. */
  async function serve(req, res, item, signal, token) {
    const size = HEADER_BYTES + item.dataBytes;
    const range = parseRange(req.headers.range, size);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("X-Csp-Representation-Id", "mr1_" + createHash("sha256").update(`tesplay-audio-compat-v1\0${token}\0${item.format}\0${size}`).digest("base64url"));
    if (range === false) return res.status(416).set("Content-Range", `bytes */${size}`).end();
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    if (end >= HEADER_BYTES && running >= maxProcesses)
      throw providerError("Audio conversion is busy. Try again in a moment.", 503);
    if (range) res.status(206).set("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    if (req.method === "HEAD") return res.end();
    const stop = new AbortController();
    const closed = () => stop.abort();
    res.once("close", closed);
    signal.addEventListener("abort", closed, { once: true });
    try {
      await pipeline(Readable.from(body(item, start, end, stop.signal), { objectMode: false }), res, { signal });
    } catch (error) {
      // The player closes reads it no longer needs; that is not a failure.
      if (signal.aborted || res.destroyed || error.code === "ERR_STREAM_PREMATURE_CLOSE") return;
      throw error;
    }
  }

  return { probe, serve, close: loopback.close };
}
