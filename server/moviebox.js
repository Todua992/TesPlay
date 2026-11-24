// MovieBox Pro (movieboxpro.app) provider.
//
// Talks to the MovieBox Pro mobile API (mbpapi.shegu.net). Every request is a
// form POST whose `data` field carries a 3DES-encrypted, MD5-signed JSON
// payload. Sign-in uses the same device pairing as the MovieBox Pro TV apps:
// TesPlay asks for a code (Add_captcha), shows it, and polls Login_captcha_v2
// until the user approves the code on movieboxpro.app while logged in.
import { createCipheriv, createHash } from "node:crypto";
import { plainText } from "./text.js";
import { providerError } from "./media.js";

const API_URL = "https://mbpapi.shegu.net/api/api_client/index/";
const APP_KEY = "moviebox";
const CIPHER_KEY = "123d6cedf626dy54233aa1w6"; // 24-byte 3DES key
const CIPHER_IV = "wEiphTn!"; // 8-byte IV
const APP_ID = "com.movieboxpro.android";
const APP_VERSION = "15.5";
const SOURCE = "MovieBox Pro";
const PROVIDER = "moviebox";
const SITE = "https://www.movieboxpro.app";
// Renew the session token once it is within a week of expiring.
const REFRESH_WINDOW_SECONDS = 7 * 24 * 3600;
const PAGE_SIZE = 24;

export const md5Hex = (value) => createHash("md5").update(String(value ?? ""), "utf8").digest("hex");

export function encryptPayload(text) {
  const cipher = createCipheriv("des-ede3-cbc", Buffer.from(CIPHER_KEY, "utf8"), Buffer.from(CIPHER_IV, "utf8"));
  return Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]).toString("base64");
}

/** Build the base64 `data` form field for one API call. */
export function encodeRequest(payload) {
  const encryptData = encryptPayload(JSON.stringify(payload));
  const appKey = md5Hex(APP_KEY);
  const envelope = { app_key: appKey, verify: md5Hex(appKey + CIPHER_KEY + encryptData), encrypt_data: encryptData };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** Decode (without verifying) a MovieBox Pro session JWT: { uid, token, exp }. */
export function decodeSessionToken(jwt) {
  const part = String(jwt || "").split(".")[1];
  if (!part) return null;
  try {
    const body = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const uid = body?.data?.uid;
    if (!uid) return null;
    return { uid: String(uid), token: String(body.data.token || ""), exp: Number(body.exp) || 0 };
  } catch {
    return null;
  }
}

/** Stable per-connection device id (MovieBox Pro rate-limits and counts devices by it). */
export const openUdidFor = (c) => String(c?.config?.openUdid || md5Hex(`tesplay-moviebox:${c?.id || ""}`));

const sessionOf = (c) => {
  const s = c?.config?.session;
  return s && typeof s.uid === "string" && s.uid ? s : null;
};

/** Pull the session JWT + user details out of a login/refresh response. */
export function sessionFromLogin(data) {
  const d = data && typeof data === "object" ? data : {};
  const candidates = [d.uid_v2, d.uid_token, d.uid, d.ui, d.token];
  const uid = candidates.find((value) => typeof value === "string" && decodeSessionToken(value));
  if (!uid) return null;
  const info = decodeSessionToken(uid);
  const vip = Number(d.isvip ?? d.is_vip ?? d.vip ?? 0) > 0;
  return {
    uid,
    exp: Number(d.uid_v2_exp) || info.exp || 0,
    user: {
      name: plainText(d.username || d.nickname || d.user_name || d.email || ""),
      vip,
    },
  };
}

export function createMovieBoxClient({ fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;

  async function call(c, module, params = {}, { session = sessionOf(c), timeout = 20000 } = {}) {
    const payload = {
      childmode: "0",
      app_version: APP_VERSION,
      appid: APP_ID,
      lang: "en",
      platform: "android",
      channel: "Website",
      open_udid: openUdidFor(c),
      expired_date: String(Math.floor(Date.now() / 1000) + 43200),
      ...(session ? { uid: session.uid } : {}),
      module,
      ...params,
    };
    const body = new URLSearchParams({ data: encodeRequest(payload), appid: "27", platform: "android" });
    let response;
    try {
      response = await doFetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Platform: "android",
          Accept: "text/plain; charset=utf-8",
          "User-Agent": "okhttp/3.2.0",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw providerError("MovieBox Pro could not be reached. Try again in a moment.", 502);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw providerError(`MovieBox Pro returned an invalid response (HTTP ${response.status}).`, 502);
    }
  }

  // Step 1 of device pairing: get a code for the user to approve on the website.
  async function startCodeLogin(c) {
    const res = await call(c, "Add_captcha", {}, { session: null });
    const code = res?.data?.code;
    if (res?.code !== 1 || typeof code !== "string" || !code) {
      throw providerError(res?.msg || "MovieBox Pro did not return a sign-in code.", 502);
    }
    return { code };
  }

  // Step 2: poll until the user approves the code. 1 = approved, -101 = device limit full.
  async function pollCodeLogin(c, code) {
    const clean = String(code || "").trim();
    if (!/^[A-Za-z0-9]{4,16}$/.test(clean)) throw providerError("This sign-in code is not valid. Start again.");
    const res = await call(c, "Login_captcha_v2", { openudid: openUdidFor(c), code: clean }, { session: null });
    if (res?.code === -101) {
      throw providerError("Your MovieBox Pro account has reached its device limit. Remove a device on movieboxpro.app, then try again.", 409);
    }
    if (res?.code !== 1) return { status: "pending" };
    const session = sessionFromLogin(res.data);
    if (!session) throw providerError("MovieBox Pro approved the code but returned no session.", 502);
    // Register this device the way the official TV apps do; failures are non-fatal.
    await call(c, "Device_v3", {
      device_name: "TesPlay",
      device_model: "TesPlay",
    }, { session }).catch(() => null);
    return { status: "approved", session };
  }

  // Renew a session that is close to expiring (User_token).
  async function refreshSession(c, session) {
    const res = await call(c, "User_token", {}, { session });
    if (res?.code !== 1) return null;
    const renewed = sessionFromLogin(res.data);
    return renewed ? { ...renewed, user: { ...session.user, ...Object.fromEntries(Object.entries(renewed.user).filter(([, v]) => v)) } } : null;
  }

  return { call, startCodeLogin, pollCodeLogin, refreshSession };
}

// ---- catalogue mapping ------------------------------------------------------

const imageUrl = (raw) => {
  const url = typeof raw === "string" ? raw.trim() : "";
  if (!url) return undefined;
  if (url.startsWith("//")) return `https:${url}`;
  return /^https?:\/\//i.test(url) ? url : undefined;
};
const isSeriesType = (boxType) => Number(boxType) === 2;

export function mapMovieBoxItem(req, c, raw, art, kindHint) {
  const id = String(raw?.id ?? raw?.mid ?? raw?.tid ?? "").trim();
  if (!/^\d+$/.test(id) || id === "0") return null;
  const series = raw?.box_type != null ? isSeriesType(raw.box_type) : kindHint === "series";
  const poster = imageUrl(raw?.poster_org) || imageUrl(raw?.poster) || imageUrl(raw?.poster_2) || imageUrl(raw?.poster_min);
  const backdrop = imageUrl(raw?.banner_mini_org) || imageUrl(raw?.banner_mini) || poster;
  const genres = plainText(raw?.cats || "").split(",").map((g) => g.trim()).filter(Boolean);
  const rating = raw?.imdb_rating && raw.imdb_rating !== "0" ? `★ ${raw.imdb_rating}` : "";
  const year = /\b(19|20)\d{2}\b/.exec(String(raw?.year || raw?.released || ""))?.[0];
  const runtime = Number(raw?.runtime) || 0;
  return {
    id,
    connectionId: c.id,
    source: SOURCE,
    providerType: PROVIDER,
    type: series ? "series" : "movie",
    contentKind: series ? "series" : "movie",
    title: plainText(raw?.title || "Untitled"),
    description: plainText(raw?.description || ""),
    year,
    duration: runtime > 0 ? runtime * 60 : undefined,
    category: genres[0],
    categoryLabel: [genres[0], rating].filter(Boolean).join(" · ") || undefined,
    subtitle: genres.join(", ") || undefined,
    poster: poster ? art(req, c, poster) : undefined,
    backdrop: backdrop ? art(req, c, backdrop) : undefined,
    artwork: "poster",
  };
}

const dedupe = (items) => [...new Map(items.filter(Boolean).map((i) => [`${i.type}:${i.id}`, i])).values()];
const listOf = (data) => (Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : []);

/** Parse "tid:season:episode" (episodes) or a bare numeric id (movie/series). */
export function parseItemId(raw) {
  const parts = String(raw || "").split(":");
  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    return { id: parts[0], season: Number(parts[1]), episode: Number(parts[2]), isEpisode: true };
  }
  if (!/^\d+$/.test(parts[0])) throw providerError("This MovieBox Pro title is not valid.");
  return { id: parts[0], season: 0, episode: 0, isEpisode: false };
}

const QUALITY_HEIGHT = { "4K": 2160, "2160P": 2160, "1440P": 1440, "1080P": 1080, "720P": 720, "480P": 480, "360P": 360, "240P": 240 };
const qualityHeight = (q) => QUALITY_HEIGHT[String(q || "").toUpperCase()] || 0;

/** Browser-friendly first: playable, H.264, MP4, highest quality up to 1080p. */
export function rankStreams(list) {
  const playable = list.filter((s) => typeof s?.path === "string" && /^https?:\/\//i.test(s.path) && !/vip_only/i.test(s.path));
  const score = (s) => {
    const height = qualityHeight(s.real_quality) || Number(s.height) || 0;
    const mp4 = /\.mp4(?:$|\?)/i.test(s.path) ? 1 : 0;
    const h264 = Number(s.h265) ? 0 : 1;
    const fits = height && height <= 1080 ? 1 : 0;
    return h264 * 1e7 + mp4 * 1e6 + fits * 1e5 + height;
  };
  return [...playable].sort((a, b) => score(b) - score(a));
}

const streamLabel = (s) =>
  [s.real_quality || "Auto", Number(s.h265) ? "H.265" : "", Number(s.hdr) ? "HDR" : "", Number(s.vip_only) ? "VIP" : ""].filter(Boolean).join(" · ");

export function createMovieBoxService({ client, art, media, cached, cacheKey, persistSession }) {
  // Return a usable session, renewing it when it is close to expiring.
  async function activeSession(req, c) {
    const session = sessionOf(c);
    if (!session) return null;
    const now = Math.floor(Date.now() / 1000);
    if (session.exp && session.exp - now < REFRESH_WINDOW_SECONDS) {
      const renewed = await client.refreshSession(c, session).catch(() => null);
      if (renewed) {
        c.config = { ...c.config, session: renewed };
        await persistSession?.(req, c, renewed);
        return renewed;
      }
      if (session.exp <= now) {
        throw providerError("Your MovieBox Pro sign-in expired. Sign in again from the MovieBox Pro page.", 401);
      }
    }
    return session;
  }

  async function requireSession(req, c) {
    const session = await activeSession(req, c);
    if (!session) throw providerError("Sign in to MovieBox Pro to play titles.", 401);
    return session;
  }

  async function homeRows(c, page) {
    return cached(`${cacheKey(c)}:home:${page}`, async () => {
      const res = await client.call(c, "Home_list_type_v2", { type: "all", page: String(page), pagelimit: "10" });
      if (res?.code !== 1) throw providerError(res?.msg || "MovieBox Pro could not load its catalogue.", 502);
      return listOf(res.data);
    }, 300);
  }

  async function discoverShelves(req, c) {
    const rows = await homeRows(c, 1);
    const shelves = rows
      .map((row, index) => ({
        id: `row-${index}`,
        title: plainText(row?.name || "") || "Featured",
        items: dedupe(listOf(row?.list).map((raw) => mapMovieBoxItem(req, c, raw, art))),
      }))
      .filter((shelf) => shelf.items.length > 0);
    return { shelves, suggestions: [] };
  }

  async function browseCatalog(req, c, { tab = "trending", page = 1, q = "", kind = "all" } = {}) {
    if (q) {
      const type = kind === "movie" ? "movie" : kind === "series" ? "tv" : "all";
      const res = await client.call(c, "Search5", { keyword: q, type, page: String(page), pagelimit: String(PAGE_SIZE), private_mode: "1" });
      if (res?.code !== 1) throw providerError(res?.msg || "MovieBox Pro search failed.", 502);
      const raw = listOf(res.data);
      return { items: dedupe(raw.map((r) => mapMovieBoxItem(req, c, r, art))), hasMore: raw.length >= PAGE_SIZE };
    }
    const rows = await homeRows(c, page);
    let items = dedupe(rows.flatMap((row) => listOf(row?.list).map((raw) => mapMovieBoxItem(req, c, raw, art))));
    if (tab === "movies") items = items.filter((i) => i.type === "movie");
    if (tab === "series") items = items.filter((i) => i.type === "series");
    return { items, hasMore: rows.length > 0 };
  }

  async function seriesDetail(c, tid) {
    return cached(`${cacheKey(c)}:tv:${tid}`, async () => {
      const res = await client.call(c, "TV_detail_1", { tid, display_all: "1" });
      if (res?.code !== 1 || !res.data) throw providerError(res?.msg || "MovieBox Pro could not load this series.", 502);
      return res.data;
    }, 600);
  }

  async function resolveEpisodes(req, c, itemId) {
    const { id: tid } = parseItemId(itemId);
    const detail = await seriesDetail(c, tid);
    const seasons = Array.isArray(detail.season) && detail.season.length
      ? detail.season.map(Number).filter((n) => n > 0)
      : Array.from({ length: Number(detail.max_season) || 1 }, (_, i) => i + 1);
    const poster = imageUrl(detail.poster_org) || imageUrl(detail.poster);
    const items = [];
    // Sequential on purpose: MovieBox Pro bans clients that hammer the API.
    for (const season of seasons) {
      const episodes = await cached(`${cacheKey(c)}:tv:${tid}:s${season}`, async () => {
        const res = await client.call(c, "TV_episode", { tid, season: String(season), display_all: "1", year: "0" });
        return res?.code === 1 ? listOf(res.data) : [];
      }, 600);
      for (const ep of episodes) {
        const number = Number(ep?.episode) || 0;
        if (number <= 0) continue;
        const thumb = imageUrl(ep.thumbs_original) || imageUrl(ep.thumbs) || poster;
        items.push({
          id: `${tid}:${season}:${number}`,
          seriesId: tid,
          connectionId: c.id,
          source: SOURCE,
          providerType: PROVIDER,
          type: "episode",
          title: plainText(ep.title || `Episode ${number}`),
          description: plainText(ep.synopsis || detail.description || ""),
          seasonNumber: season,
          episodeNumber: number,
          duration: Number(ep.runtime) > 0 ? Number(ep.runtime) * 60 : undefined,
          poster: thumb ? art(req, c, thumb) : undefined,
          backdrop: thumb ? art(req, c, thumb) : undefined,
          artwork: "poster",
        });
      }
    }
    return items;
  }

  // Fetch stream sources; retries with the session token as device id, which
  // some accounts require for download URLs.
  async function fetchStreams(req, c, parsed, isSeries) {
    const session = await requireSession(req, c);
    const module = isSeries ? "TV_downloadurl_v3" : "Movie_downloadurl_v3";
    const params = isSeries
      ? { tid: parsed.id, season: String(parsed.season || 1), episode: String(parsed.episode || 1) }
      : { mid: parsed.id };
    let res = await client.call(c, module, { ...params, oss: "1", group: "" }, { session });
    const tokenUdid = decodeSessionToken(session.uid)?.token;
    if ((res?.code !== 1 || !listOf(res.data).length) && tokenUdid) {
      res = await client.call(c, module, { ...params, oss: "1", group: "", open_udid: tokenUdid }, { session });
    }
    if (res?.code !== 1) throw providerError(res?.msg || "MovieBox Pro could not load streams for this title.", 502);
    return { session, all: listOf(res.data), ranked: rankStreams(listOf(res.data)) };
  }

  async function fetchSubtitles(c, session, parsed, isSeries, fid) {
    if (!fid) return [];
    const module = isSeries ? "TV_srt_list_v3" : "Movie_srt_list_v3";
    const params = isSeries
      ? { tid: parsed.id, season: String(parsed.season || 1), episode: String(parsed.episode || 1) }
      : { mid: parsed.id };
    const res = await client.call(c, module, { ...params, fid: String(fid), lang: "en" }, { session }).catch(() => null);
    if (res?.code !== 1) return [];
    const subtitles = listOf(res.data).flatMap((group) => (Array.isArray(group?.subtitles) ? group.subtitles : []));
    return dedupe(
      subtitles
        .filter((s) => typeof s?.file_path === "string" && /^https?:\/\//i.test(s.file_path))
        .slice(0, 60)
        .map((s, index) => ({
          id: `mbp-sub-${s.sid || index}`,
          type: "subtitle",
          label: plainText(s.language || s.lang || "Subtitles"),
          language: String(s.lang || "").slice(0, 12) || undefined,
          url: s.file_path,
        })),
    );
  }

  async function resolvePlaybackOptions(req, c, itemId, kind) {
    const parsed = parseItemId(itemId);
    const isSeries = parsed.isEpisode || kind === "episode" || kind === "series";
    const { ranked, all } = await fetchStreams(req, c, parsed, isSeries);
    if (!ranked.length) {
      const vipOnly = all.some((s) => Number(s?.vip_only) || /vip_only/i.test(String(s?.path || "")));
      throw providerError(vipOnly ? "This title needs a MovieBox Pro VIP account." : "MovieBox Pro has no playable stream for this title yet.", 404);
    }
    return {
      audio: [],
      subtitles: [],
      qualities: [...new Map(ranked.map((s) => [String(s.real_quality || "auto").toLowerCase(), { id: String(s.real_quality || "auto").toLowerCase(), label: s.real_quality || "Auto" }])).values()],
      sources: ranked.map((s) => ({
        id: `mbp-src-${s.fid}`,
        label: streamLabel(s),
        description: plainText(s.filename || "").slice(0, 120) || undefined,
        addon: SOURCE,
      })),
    };
  }

  async function resolvePlayback(req, c, itemId, kind, query = {}) {
    const parsed = parseItemId(itemId);
    const isSeries = parsed.isEpisode || kind === "episode" || kind === "series";
    const { session, ranked } = await fetchStreams(req, c, parsed, isSeries);
    if (!ranked.length) throw providerError("MovieBox Pro has no playable stream for this title yet.", 404);
    const wantedFid = /^mbp-src-\d+$/.test(String(query.sourceId || "")) ? String(query.sourceId).slice(8) : "";
    const wantedQuality = query.qualityId && query.qualityId !== "auto" ? String(query.qualityId).toLowerCase() : "";
    const chosen =
      ranked.find((s) => wantedFid && String(s.fid) === wantedFid) ||
      ranked.find((s) => wantedQuality && String(s.real_quality || "").toLowerCase() === wantedQuality) ||
      ranked[0];
    const headers = { "User-Agent": "okhttp/3.2.0", Referer: `${SITE}/` };
    const isHls = /\.m3u8(?:$|\?)/i.test(chosen.path);
    const subtitles = await fetchSubtitles(c, session, parsed, isSeries, chosen.fid);
    return {
      provider: PROVIDER,
      url: media.register(req, c, { url: chosen.path, headers, kind: isHls ? "hls" : "video" }),
      type: isHls ? "hls" : "video",
      ...(isHls ? {} : { streamKind: "direct-file" }),
      subtitles: subtitles.map((s) => ({
        id: s.id,
        label: s.label,
        language: s.language,
        url: media.register(req, c, { url: s.url, headers, kind: "subtitle" }),
      })),
    };
  }

  return { discoverShelves, browseCatalog, resolveEpisodes, resolvePlaybackOptions, resolvePlayback };
}

export function registerMovieBoxRoutes(app, { ctx, connection, route, art, media, cached, cacheKey, dependencies = {} }) {
  const client = dependencies.movieboxClient || createMovieBoxClient();
  const manager = ctx.requireConnectionManager || ((_req, _res, next) => next());
  // Saved configs merge, so clear keys explicitly. LEGACY_KEYS are leftovers of
  // the old aoneroom MovieBox integration.
  const LEGACY_KEYS = { authMode: null, account: null, token: null, userId: null, userInfo: null, region: null, deviceId: null, baseUrl: null };
  const saveConfig = (req, c, config) =>
    ctx.saveConnection(req, { id: c.id, type: c.type, name: c.name, config: { ...LEGACY_KEYS, ...config } });
  const service = createMovieBoxService({
    client,
    art,
    media,
    cached,
    cacheKey,
    persistSession: async (req, c, session) => {
      try {
        saveConfig(req, c, { session });
      } catch {
        /* a renewed token that fails to persist is retried on the next request */
      }
    },
  });

  app.post("/api/moviebox/:connectionId/login/start", manager, route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    const { code } = await client.startCodeLogin(c);
    res.json({ code, approveUrl: SITE, pollSeconds: 3 });
  }));

  app.post("/api/moviebox/:connectionId/login/poll", manager, route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    const result = await client.pollCodeLogin(c, req.body?.code);
    if (result.status !== "approved") return res.json({ status: "pending" });
    const updated = saveConfig(req, c, { session: result.session });
    res.json({ status: "approved", connection: updated, user: result.session.user });
  }));

  app.post("/api/moviebox/:connectionId/logout", manager, route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    res.json({ connection: saveConfig(req, c, { session: null }) });
  }));

  app.get("/api/moviebox/:connectionId/discover", route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    res.json(await service.discoverShelves(req, c));
  }));

  app.get("/api/moviebox/:connectionId/browse", route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    const page = Math.max(1, Math.min(50, Number(req.query.page || 1) || 1));
    res.json(await service.browseCatalog(req, c, { tab: String(req.query.tab || "trending"), page }));
  }));

  app.get("/api/moviebox/:connectionId/search", route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    const q = String(req.query.q || "").trim().slice(0, 200);
    if (!q) return res.json({ items: [], hasMore: false });
    const page = Math.max(1, Math.min(50, Number(req.query.page || 1) || 1));
    res.json(await service.browseCatalog(req, c, { q, page, kind: String(req.query.kind || "all") }));
  }));

  return service;
}
