import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import {
  createMovieBoxClient,
  createMovieBoxService,
  decodeSessionToken,
  encodeRequest,
  openUdidFor,
  parseItemId,
  rankStreams,
  sessionFromLogin,
} from "../server/moviebox.js";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (uid, token, exp) => `${b64url({ typ: "JWT", alg: "HS256" })}.${b64url({ exp, data: { uid, token } })}.sig`;
const inDays = (d) => Math.floor(Date.now() / 1000) + d * 86400;

// Decode a request the way the MovieBox Pro API does, so tests assert on what
// TesPlay actually sends.
function decodeBody(body) {
  const data = new URLSearchParams(body).get("data");
  const envelope = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  const d = createDecipheriv("des-ede3-cbc", Buffer.from("123d6cedf626dy54233aa1w6"), Buffer.from("wEiphTn!"));
  const payload = JSON.parse(Buffer.concat([d.update(envelope.encrypt_data, "base64"), d.final()]).toString("utf8"));
  return { envelope, payload };
}

function fakeApi(handlers) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    assert.equal(url, "https://mbpapi.shegu.net/api/api_client/index/");
    const { payload } = decodeBody(opts.body);
    calls.push(payload);
    const handler = handlers[payload.module];
    const body = handler ? handler(payload, calls) : { code: 0, msg: "unknown module" };
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

const conn = (config = {}) => ({ id: "mbp-1", type: "moviebox", name: "MovieBox Pro", config });

function service(handlers) {
  const api = fakeApi(handlers);
  const registered = [];
  const persisted = [];
  const svc = createMovieBoxService({
    client: createMovieBoxClient({ fetchImpl: api.fetchImpl }),
    art: (_req, _c, u) => `art:${u}`,
    media: { register: (_req, _c, r) => (registered.push(r), `/api/media/tok-${registered.length}`) },
    cached: async (_k, fn) => fn(),
    cacheKey: (c) => c.id,
    persistSession: async (_req, _c, s) => persisted.push(s),
  });
  return { svc, calls: api.calls, registered, persisted };
}

test("requests are 3DES-encrypted and MD5-signed like the MovieBox Pro app", () => {
  const payload = { module: "Add_captcha", expired_date: "123" };
  const data = encodeRequest(payload);
  const { envelope, payload: decoded } = decodeBody(new URLSearchParams({ data }).toString());
  assert.deepEqual(decoded, payload);
  assert.equal(envelope.app_key, md5("moviebox"));
  assert.equal(envelope.verify, md5(md5("moviebox") + "123d6cedf626dy54233aa1w6" + envelope.encrypt_data));
});

test("session helpers decode the JWT and pick the session out of a login response", () => {
  const token = jwt(21433047, "abc123", inDays(30));
  assert.deepEqual(decodeSessionToken(token), { uid: "21433047", token: "abc123", exp: inDays(30) });
  assert.equal(decodeSessionToken("not-a-jwt"), null);
  const session = sessionFromLogin({ uid: "21433047", uid_v2: token, username: "luka", isvip: 1 });
  assert.equal(session.uid, token);
  assert.deepEqual(session.user, { name: "luka", vip: true });
  assert.equal(sessionFromLogin({ uid: "21433047" }), null);
  assert.notEqual(openUdidFor({ id: "a" }), openUdidFor({ id: "b" }));
  assert.match(openUdidFor({ id: "a" }), /^[0-9a-f]{32}$/);
});

test("code login: get a code, stay pending until approved, then register the device", async () => {
  const token = jwt(7, "devtok", inDays(30));
  let polls = 0;
  const api = fakeApi({
    Add_captcha: () => ({ code: 1, msg: "success", data: { code: "AB12CD34" } }),
    Login_captcha_v2: (p) => {
      assert.equal(p.code, "AB12CD34");
      assert.equal(p.openudid, openUdidFor(conn()));
      assert.equal(p.uid, undefined, "pairing must not send a session");
      polls += 1;
      return polls < 2 ? { code: 0, msg: "waiting" } : { code: 1, data: { uid_v2: token, username: "luka", isvip: 1 } };
    },
    Device_v3: (p) => (assert.equal(p.uid, token), { code: 1 }),
  });
  const client = createMovieBoxClient({ fetchImpl: api.fetchImpl });
  assert.deepEqual(await client.startCodeLogin(conn()), { code: "AB12CD34" });
  assert.deepEqual(await client.pollCodeLogin(conn(), "AB12CD34"), { status: "pending" });
  const approved = await client.pollCodeLogin(conn(), "AB12CD34");
  assert.equal(approved.status, "approved");
  assert.equal(approved.session.uid, token);
  assert.equal(approved.session.user.vip, true);
  assert.deepEqual(api.calls.map((c) => c.module), ["Add_captcha", "Login_captcha_v2", "Login_captcha_v2", "Device_v3"]);
});

test("code login reports a full device list and rejects malformed codes", async () => {
  const api = fakeApi({ Login_captcha_v2: () => ({ code: -101, msg: "device limit" }) });
  const client = createMovieBoxClient({ fetchImpl: api.fetchImpl });
  await assert.rejects(client.pollCodeLogin(conn(), "AB12CD34"), (e) => e.status === 409 && /device limit/.test(e.message));
  await assert.rejects(client.pollCodeLogin(conn(), "../bad"), /not valid/);
});

test("discover, browse and search map MovieBox Pro titles", async () => {
  const { svc, calls } = service({
    Home_list_type_v5: () => ({
      code: 1,
      data: [
        { name: "Hot Movies", list: [{ id: 11, box_type: 1, title: "Inception", poster: "https://img/p.jpg", year: 2010, imdb_rating: "8.8", cats: "Sci-Fi,Action" }] },
        { name: "Hot TV", list: [{ id: 22, box_type: 2, title: "SEAL Team", poster: "https://img/s.jpg" }] },
        { name: "Empty", list: [] },
      ],
    }),
    Search5: (p) => {
      assert.equal(p.keyword, "batman");
      assert.equal(p.type, "all");
      return { code: 1, data: [{ id: 33, box_type: 1, title: "The Batman", poster_org: "https://img/b.jpg", year: 2022 }] };
    },
  });
  const discover = await svc.discoverShelves({}, conn());
  assert.deepEqual(discover.shelves.map((s) => s.title), ["Hot Movies", "Hot TV"]);
  const movie = discover.shelves[0].items[0];
  assert.equal(movie.id, "11");
  assert.equal(movie.type, "movie");
  assert.equal(movie.providerType, "moviebox");
  assert.equal(movie.year, "2010");
  assert.equal(movie.poster, "art:https://img/p.jpg");
  assert.equal(movie.categoryLabel, "Sci-Fi · ★ 8.8");
  assert.equal(discover.shelves[1].items[0].type, "series");

  const series = await svc.browseCatalog({}, conn(), { tab: "series", page: 1 });
  assert.deepEqual(series.items.map((i) => i.title), ["SEAL Team"]);

  const search = await svc.browseCatalog({}, conn(), { q: "batman", page: 1 });
  assert.deepEqual(search.items.map((i) => i.title), ["The Batman"]);
  assert.equal(search.items[0].poster, "art:https://img/b.jpg");
  assert.ok(calls.every((c) => c.uid === undefined), "browsing while signed out sends no session");
});

test("episodes come from the series' season list", async () => {
  const { svc } = service({
    TV_detail_1: () => ({ code: 1, data: { title: "Show", season: [1, 2], description: "A show", poster: "https://img/s.jpg" } }),
    TV_episode: (p) => ({
      code: 1,
      data: p.season === "1"
        ? [{ episode: 1, title: "Pilot", runtime: 42 }, { episode: 2, title: "Two" }]
        : [{ episode: 1, title: "Return", thumbs: "https://img/e.jpg" }],
    }),
  });
  const episodes = await svc.resolveEpisodes({}, conn(), "55");
  assert.deepEqual(episodes.map((e) => e.id), ["55:1:1", "55:1:2", "55:2:1"]);
  assert.equal(episodes[0].duration, 42 * 60);
  assert.equal(episodes[2].poster, "art:https://img/e.jpg");
});

test("stream ranking prefers browser-friendly H.264 MP4 up to 1080p and drops VIP placeholders", () => {
  const ranked = rankStreams([
    { fid: 1, real_quality: "4K", path: "https://cdn/4k.mp4", h265: 1 },
    { fid: 2, real_quality: "1080p", path: "https://cdn/1080.mkv" },
    { fid: 3, real_quality: "1080p", path: "https://cdn/1080.mp4?sig=1" },
    { fid: 4, real_quality: "720p", path: "https://cdn/720.mp4" },
    { fid: 5, real_quality: "ORG", path: "https://site/static/video/vip_only.mp4" },
    { fid: 6, real_quality: "480p", path: "" },
  ]);
  assert.deepEqual(ranked.map((s) => s.fid), [3, 4, 2, 1]);
});

test("playback needs a session, proxies the best stream and its subtitles", async () => {
  const token = jwt(9, "tok9", inDays(30));
  const signedIn = conn({ session: { uid: token, exp: inDays(30), user: { name: "luka", vip: true } } });
  const { svc, registered } = service({
    Movie_downloadurl_v3: (p) => {
      assert.equal(p.mid, "11");
      assert.equal(p.uid, token);
      return { code: 1, data: { list: [
        { fid: 70, real_quality: "4K", path: "https://cdn/4k.mkv", h265: 1, vip_only: 1 },
        { fid: 71, real_quality: "1080p", path: "https://cdn/1080.mp4" },
      ] } };
    },
    Movie_srt_list_v3: (p) => ({
      code: 1,
      data: { list: [{ subtitles: [{ sid: 5, lang: "en", language: "English", file_path: `https://subs/${p.fid}.srt` }] }] },
    }),
  });

  await assert.rejects(svc.resolvePlayback({}, conn(), "11", "movie"), (e) => e.status === 401);

  const options = await svc.resolvePlaybackOptions({}, signedIn, "11", "movie");
  assert.deepEqual(options.sources.map((s) => s.id), ["mbp-src-71", "mbp-src-70"]);
  assert.equal(options.sources[1].label, "4K · H.265 · VIP");

  const playback = await svc.resolvePlayback({}, signedIn, "11", "movie");
  assert.equal(playback.provider, "moviebox");
  assert.equal(playback.streamKind, "direct-file");
  assert.equal(registered[0].url, "https://cdn/1080.mp4");
  assert.equal(registered[0].kind, "video");
  assert.equal(playback.subtitles[0].label, "English");
  assert.equal(registered[1].kind, "subtitle");
  assert.equal(registered[1].url, "https://subs/71.srt");

  await svc.resolvePlayback({}, signedIn, "11", "movie", { sourceId: "mbp-src-70" });
  assert.equal(registered.at(-2).url, "https://cdn/4k.mkv");
  assert.equal(registered.at(-1).url, "https://subs/70.srt");
});

test("episode playback sends tid/season/episode", async () => {
  const token = jwt(9, "tok9", inDays(30));
  const signedIn = conn({ session: { uid: token, exp: inDays(30), user: {} } });
  const { svc } = service({
    TV_downloadurl_v3: (p) => {
      assert.deepEqual([p.tid, p.season, p.episode], ["55", "2", "3"]);
      return { code: 1, data: { list: [{ fid: 1, real_quality: "720p", path: "https://cdn/e.mp4" }] } };
    },
    TV_srt_list_v3: () => ({ code: 1, data: { list: [] } }),
  });
  const playback = await svc.resolvePlayback({}, signedIn, "55:2:3", "episode");
  assert.equal(playback.subtitles.length, 0);
});

test("a session close to expiry is renewed with User_token and persisted", async () => {
  const old = jwt(9, "old", inDays(2));
  const renewed = jwt(9, "new", inDays(30));
  const signedIn = conn({ session: { uid: old, exp: inDays(2), user: { name: "luka", vip: true } } });
  const { svc, persisted } = service({
    User_token: (p) => (assert.equal(p.uid, old), { code: 1, data: { uid_v2: renewed } }),
    Movie_downloadurl_v3: (p) => (assert.equal(p.uid, renewed), { code: 1, data: { list: [{ fid: 1, real_quality: "720p", path: "https://cdn/m.mp4" }] } }),
    Movie_srt_list_v3: () => ({ code: 1, data: { list: [] } }),
  });
  await svc.resolvePlayback({}, signedIn, "11", "movie");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].uid, renewed);
  assert.deepEqual(persisted[0].user, { name: "luka", vip: true });
});

test("item ids are validated", () => {
  assert.deepEqual(parseItemId("55:2:3"), { id: "55", season: 2, episode: 3, isEpisode: true });
  assert.deepEqual(parseItemId("11"), { id: "11", season: 0, episode: 0, isEpisode: false });
  assert.throws(() => parseItemId("../etc"), /not valid/);
});

test("home feed falls back past rejected modules and never fails the page", async () => {
  const tried = [];
  const { svc } = service({
    Home_list_type_v5: (p) => (tried.push(p.module), { code: 0, msg: "module_not_allowed" }),
    Home_list_type_v2: (p) => (tried.push(p.module), { code: 1, data: [{ name: "Row", list: [{ id: 1, box_type: 1, title: "A" }] }] }),
  });
  const discover = await svc.discoverShelves({}, conn());
  assert.deepEqual(tried, ["Home_list_type_v5", "Home_list_type_v2"]);
  assert.equal(discover.shelves[0].items[0].title, "A");

  const none = service({
    Home_list_type_v5: () => ({ code: 0, msg: "module_not_allowed" }),
    Home_list_type_v2: () => ({ code: 0, msg: "module_not_allowed" }),
  });
  const empty = await none.svc.discoverShelves({}, conn());
  assert.deepEqual(empty.shelves, []);
});

test("an empty stream list re-registers the device and explains what came back", async () => {
  const token = jwt(9, "tok9", inDays(30));
  const signedIn = conn({ session: { uid: token, exp: inDays(30), user: {} } });
  const { svc, calls } = service({
    Movie_downloadurl_v3: () => ({ code: 1, msg: "success", data: { seconds: 0, quality: ["1080p"], ip: "x", list: [{ fid: 1, real_quality: "1080p", path: "" }, { fid: 2, real_quality: "4K", path: "", vip_only: 1 }] } }),
    Device_v3: () => ({ code: 1, msg: "ok" }),
    Device_list: () => ({ code: 1, data: { list: [{ open_udid: openUdidFor(signedIn), device_name: "TesPlay" }] } }),
  });
  await assert.rejects(svc.resolvePlayback({}, signedIn, "11", "movie"), (e) => {
    assert.equal(e.status, 404);
    assert.match(e.message, /list=2 withPath=0 vip=1/);
    assert.match(e.message, /quality=\["1080p"\]/);
    assert.match(e.message, /tried=app:1\/2 app\+token:1\/2 after-bind:1\/2 bind=1\/ok devices=1\/1 ours=yes/);
    assert.doesNotMatch(e.message, /https?:/);
    return true;
  });
  const tries = calls.filter((c) => c.module === "Movie_downloadurl_v3");
  assert.equal(tries.length, 3);
  assert.equal(tries[1].open_udid, "tok9");
  assert.equal(calls.filter((c) => c.module === "Device_v3").length, 1);
});

test("streams appear once the device is registered", async () => {
  const token = jwt(9, "tok9", inDays(30));
  const signedIn = conn({ session: { uid: token, exp: inDays(30), user: {} } });
  let bound = false;
  const { svc, registered } = service({
    Movie_downloadurl_v3: () => ({ code: 1, data: { list: bound ? [{ fid: 3, real_quality: "1080p", path: "https://cdn/m.mp4" }] : [] } }),
    Device_v3: () => ((bound = true), { code: 1 }),
    Device_list: () => ({ code: 1, data: [] }),
    Movie_srt_list_v3: () => ({ code: 1, data: { list: [] } }),
  });
  await svc.resolvePlayback({}, signedIn, "11", "movie");
  assert.equal(registered[0].url, "https://cdn/m.mp4");
});
