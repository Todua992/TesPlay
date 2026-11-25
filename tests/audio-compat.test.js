import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import express from 'express';
import { createAudioCompat, wavHeader, decodeArgs, chooseStream, HEADER_BYTES, SAMPLE_RATE } from '../server/audio-compat.js';
import { createMediaService, parseRange, providerError } from '../server/media.js';

// Stamp every PCM frame with its absolute index so tests can check byte alignment.
const frameBytes = index => [index & 255, (index >> 8) & 255, (index >> 16) & 255, 0x55];
function* pcm(first, last) {
  for (let start = first; start < last; start += 4096) {
    const count = Math.min(4096, last - start), chunk = Buffer.alloc(count * 4);
    for (let i = 0; i < count; i++) chunk.set(frameBytes(start + i), i * 4);
    yield chunk;
  }
}

/** A fake FFmpeg/FFprobe: decodes `sourceFrames` frames of stamped PCM from `-ss`, or prints `probe`. */
function fakeTools({ sourceFrames = SAMPLE_RATE * 4, exitCode = 0, probe, onProbe } = {}) {
  const calls = [];
  const spawnProcess = (command, args) => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.killed = false;
    calls.push({ command, args, child });
    if (command === 'ffprobe') {
      child.stdout = new PassThrough();
      child.kill = () => {};
      Promise.resolve(onProbe?.(args.at(-1))).then(() => {
        child.stdout.once('end', () => child.emit('close', 0));
        child.stdout.end(JSON.stringify(probe));
      });
      return child;
    }
    const ss = args.includes('-ss') ? Number(args[args.indexOf('-ss') + 1]) : 0;
    child.stdout = Readable.from(pcm(Math.round(ss * SAMPLE_RATE), sourceFrames), { objectMode: false });
    child.stdout.once('end', () => setImmediate(() => child.emit('close', exitCode)));
    child.kill = () => { if (!child.killed) { child.killed = true; child.stdout.destroy(); setImmediate(() => child.emit('close', null)); } };
    return child;
  };
  return { calls, spawnProcess };
}

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function wavServer(t, tools, item) {
  const audio = createAudioCompat({ requestRemote: async () => { throw new Error('no source'); }, parseRange, providerError, spawnProcess: tools.spawnProcess });
  t.after(audio.close);
  const app = express();
  app.get('/wav', (req, res, next) => audio.serve(req, res, item, new AbortController().signal, 'ticket').catch(next));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return listen(app, t);
}

const source = { url: 'https://cdn.example/movie.mkv', headers: async () => ({}), allowedPrivateHosts: [] };
const range = (start, end) => ({ headers: { Range: `bytes=${start}-${end ?? ''}` } });

test('the WAV header describes 16-bit stereo 48 kHz PCM of the given length', () => {
  const header = wavHeader(1000);
  assert.equal(header.length, HEADER_BYTES);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt32LE(4), 1036);
  assert.equal(header.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.deepEqual([header.readUInt16LE(20), header.readUInt16LE(22), header.readUInt32LE(24), header.readUInt32LE(28), header.readUInt16LE(32), header.readUInt16LE(34)], [1, 2, 48000, 192000, 4, 16]);
  assert.equal(header.toString('ascii', 36, 40), 'data');
  assert.equal(header.readUInt32LE(40), 1000);
});

test('FFmpeg reads only the loopback source, seeks only when needed and converts the chosen stream', () => {
  const start = decodeArgs('http://127.0.0.1:1/s', 0, 0), later = decodeArgs('http://127.0.0.1:1/s', 61.5, 2);
  assert.ok(!start.includes('-ss'));
  assert.deepEqual(later.slice(later.indexOf('-ss'), later.indexOf('-ss') + 2), ['-ss', '61.500000']);
  assert.ok(later.indexOf('-ss') < later.indexOf('-i'), 'Seeking happens on the input');
  assert.equal(later[later.indexOf('-map') + 1], '0:a:2');
  assert.equal(later[later.indexOf('-protocol_whitelist') + 1], 'http,tcp');
  assert.ok(!later[later.indexOf('-format_whitelist') + 1].includes('hls'), 'Playlists could fetch other addresses');
  assert.deepEqual(later.slice(-2), ['s16le', 'pipe:1']);
  const streams = [{ disposition: { default: 0 } }, { disposition: { default: 1 } }];
  assert.equal(chooseStream(streams, 1), 0);
  assert.equal(chooseStream(streams, undefined), 1);
  assert.equal(chooseStream(streams, 7), 1);
  assert.equal(chooseStream([{}], undefined), 0);
});

test('byte ranges map to exact source times, including ranges that start inside a frame', async t => {
  const tools = fakeTools(), dataBytes = SAMPLE_RATE * 4 * 4;
  const base = await wavServer(t, tools, { source, stream: 0, startTime: 0, dataBytes });
  const head = await fetch(base + '/wav', range(0, 99));
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), `bytes 0-99/${HEADER_BYTES + dataBytes}`);
  assert.match(head.headers.get('x-csp-representation-id'), /^mr1_[A-Za-z0-9_-]{43}$/);
  const first = Buffer.from(await head.arrayBuffer());
  assert.deepEqual(first.subarray(0, HEADER_BYTES), wavHeader(dataBytes));
  assert.deepEqual([...first.subarray(HEADER_BYTES, HEADER_BYTES + 8)], [...frameBytes(0), ...frameBytes(1)]);
  assert.ok(!tools.calls[0].args.includes('-ss'));
  // One second in, starting two bytes into a frame.
  const at = HEADER_BYTES + SAMPLE_RATE * 4 + 2;
  const later = Buffer.from(await (await fetch(base + '/wav', range(at, at + 9))).arrayBuffer());
  assert.deepEqual([...later], [...frameBytes(SAMPLE_RATE).slice(2), ...frameBytes(SAMPLE_RATE + 1), ...frameBytes(SAMPLE_RATE + 2)]);
  assert.equal(tools.calls[1].args[tools.calls[1].args.indexOf('-ss') + 1], '1.000000');
  assert.ok(tools.calls.every(call => call.child.killed), 'Each read stops its decoder once served');
});

test('silence fills the time before the source starts and after its audio ends', async t => {
  const tools = fakeTools({ sourceFrames: SAMPLE_RATE / 2 }), dataBytes = SAMPLE_RATE * 4 * 2;
  const base = await wavServer(t, tools, { source, stream: 0, startTime: 0.25, dataBytes });
  const lead = SAMPLE_RATE / 4 * 4;
  const edge = Buffer.from(await (await fetch(base + '/wav', range(HEADER_BYTES + lead - 4, HEADER_BYTES + lead + 3))).arrayBuffer());
  assert.deepEqual([...edge], [0, 0, 0, 0, ...frameBytes(0)], 'Source frame 0 plays at 0.25 s');
  assert.ok(!tools.calls[0].args.includes('-ss'));
  const tail = await fetch(base + '/wav', range(HEADER_BYTES + dataBytes - 8));
  assert.deepEqual([...Buffer.from(await tail.arrayBuffer())], [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('a decoder failure aborts the read instead of serving silence; HEAD and bad ranges spawn nothing', async t => {
  const tools = fakeTools({ sourceFrames: 10, exitCode: 1 }), dataBytes = SAMPLE_RATE * 4;
  const base = await wavServer(t, tools, { source, stream: 0, startTime: 0, dataBytes });
  const warn = t.mock.method(console, 'warn', () => {});
  const failed = await fetch(base + '/wav', range(0));
  await assert.rejects(failed.arrayBuffer());
  assert.equal(warn.mock.callCount(), 1);
  const head = await fetch(base + '/wav', { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(HEADER_BYTES + dataBytes));
  assert.equal((await fetch(base + '/wav', range(HEADER_BYTES + dataBytes + 10))).status, 416);
  assert.equal(tools.calls.length, 1);
});

test('closing a read stops its decoder', async t => {
  const tools = fakeTools({ sourceFrames: SAMPLE_RATE * 3600 });
  const base = await wavServer(t, tools, { source, stream: 0, startTime: 0, dataBytes: SAMPLE_RATE * 4 * 3600 });
  const controller = new AbortController();
  const response = await fetch(base + '/wav', { ...range(0), signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await reader.read().catch(() => {});
  for (let i = 0; i < 50 && !tools.calls[0].child.killed; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(tools.calls[0].child.killed);
});

test('the media API probes through the loopback proxy, converts the requested track and releases it with the video', async t => {
  const upstream = [];
  const requestRemote = async (url, options) => {
    upstream.push({ url, range: options.headers.Range, referer: options.headers.Referer });
    return Object.assign(Readable.from([Buffer.from('mkv')]), { statusCode: 206, headers: { 'content-range': 'bytes 0-2/100', 'content-length': '3' } });
  };
  let proxied;
  const tools = fakeTools({
    probe: { format: { duration: '2.000000', start_time: '0.000000' }, streams: [{ codec_name: 'aac', disposition: { default: 1 } }, { codec_name: 'eac3', disposition: { default: 0 } }] },
    onProbe: async input => {
      assert.match(input, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}$/);
      const response = await fetch(input, { headers: { Range: 'bytes=0-2' } });
      proxied = { status: response.status, body: await response.text(), range: response.headers.get('content-range') };
      assert.equal((await fetch(input.replace(/\/[^/]+$/, '/unknown'))).status, 404);
    },
  });
  const audioCompat = createAudioCompat({ requestRemote, parseRange, providerError, spawnProcess: tools.spawnProcess });
  t.after(audioCompat.close);
  const service = createMediaService({ getProfileId: () => 'profile', getConnection: () => null, audioCompat });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'viewer' }; next(); });
  app.get('/api/media/:token', service.handler);
  app.post('/api/media/:token/audio-compat', service.audioCompatHandler);
  app.delete('/api/media/:token', service.releaseHandler);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const base = await listen(app, t), req = { user: { id: 'viewer' } };
  const video = service.register(req, null, { url: 'https://cdn.example/movie.mkv', kind: 'video', headers: { Referer: 'https://site.example/' } });
  const created = await fetch(base + video + '/audio-compat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackNumber: 2 }) });
  assert.equal(created.status, 200);
  const { url, codec } = await created.json();
  assert.equal(codec, 'eac3');
  assert.deepEqual(proxied, { status: 206, body: 'mkv', range: 'bytes 0-2/100' });
  assert.deepEqual(upstream, [{ url: 'https://cdn.example/movie.mkv', range: 'bytes=0-2', referer: 'https://site.example/' }]);
  const wav = await fetch(base + url, range(0, HEADER_BYTES + 3));
  assert.equal(wav.headers.get('content-range'), `bytes 0-${HEADER_BYTES + 3}/${HEADER_BYTES + SAMPLE_RATE * 2 * 4}`);
  assert.deepEqual([...Buffer.from(await wav.arrayBuffer()).subarray(HEADER_BYTES)], frameBytes(0));
  assert.equal(tools.calls.at(-1).args[tools.calls.at(-1).args.indexOf('-map') + 1], '0:a:1');
  const playlist = service.register(req, null, { url: 'https://cdn.example/live.m3u8', kind: 'hls' });
  assert.equal((await fetch(base + playlist + '/audio-compat', { method: 'POST' })).status, 400);
  assert.equal((await fetch(base + video, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(base + url)).status, 404, 'Releasing the video releases its converted audio');
});

test('a missing FFmpeg is reported clearly', async t => {
  const audio = createAudioCompat({ requestRemote: async () => { throw new Error('unused'); }, parseRange, providerError, spawnProcess: () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' })));
    return child;
  } });
  t.after(audio.close);
  await assert.rejects(audio.probe(source), error => error.status === 501 && /FFmpeg is not installed/.test(error.message));
});
