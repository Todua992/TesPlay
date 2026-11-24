import { createHash, createHmac, randomInt } from "node:crypto";
import { plainText } from "./text.js";
import { providerError, validateRemoteUrl } from "./media.js";

const GATEWAY_SECRET_ONLINE = "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O";

// Global ("aoneroom") hosts serve the worldwide catalogue; the "inmoviebox"
// hosts are the India gateway and reject a non-IN region with
// "Service not available in current region". Region and host must match.
const GLOBAL_BASE_URLS = ["https://i-api.aoneroom.com", "https://api.aoneroom.com"];
const INDIA_BASE_URLS = ["https://apig.inmoviebox.com", "https://api6.aoneroom.com"];
const DEFAULT_BASE_URL = GLOBAL_BASE_URLS[0];

// MovieBox geo-routes its catalog off the `region` header, client-info and the
// base host. The global ("aoneroom") endpoint rejects our India app credentials
// with 403 "Service not available in current region", so IN is the only region
// that actually serves this deployment. A connection may still override via
// config.region (e.g. US) once matching global gateway credentials exist.
// Region only gates access (US/GB get 403 "Service not available in current
// region" from an EU server; EU/DE/FR/IN return the same global catalogue), so
// default to EU to match this deployment's location.
const DEFAULT_REGION = "EU";
const REGION_PROFILES = {
  EU: { timezone: "Europe/Copenhagen", sp_code: "23801", hosts: GLOBAL_BASE_URLS },
  DE: { timezone: "Europe/Berlin", sp_code: "26201", hosts: GLOBAL_BASE_URLS },
  FR: { timezone: "Europe/Paris", sp_code: "20801", hosts: GLOBAL_BASE_URLS },
  US: { timezone: "America/New_York", sp_code: "310260", hosts: GLOBAL_BASE_URLS },
  GB: { timezone: "Europe/London", sp_code: "23430", hosts: GLOBAL_BASE_URLS },
  IN: { timezone: "Asia/Kolkata", sp_code: "404", hosts: INDIA_BASE_URLS },
};
const regionProfile = (c) => REGION_PROFILES[c?.config?.region || DEFAULT_REGION] || REGION_PROFILES[DEFAULT_REGION];
const TRAP_MARKERS = [
  "notice.mp4",
  "1c7de0bd3393702d9191801f15f88f8d",
  "9a0461bc39da389663bf3dbb17091d3f",
  "80da52722ee7de7a4303290af6783424",
  "b164fbfb4347792950bdfbfb563d39d9",
];

const guestSessions = new Map();

export function md5Hex(data) {
  return createHash("md5").update(String(data || ""), "utf8").digest("hex");
}

export function generateClientToken(timestamp = Date.now()) {
  const ts = String(timestamp);
  const reversed = ts.split("").reverse().join("");
  return `${ts},${md5Hex(reversed)}`;
}

export function generateTrSignature(method, url, bodyData = "", timestamp = Date.now()) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw providerError(`MovieBox request URL was invalid: ${String(url).slice(0, 160)}`, 502);
  }
  const path = parsed.pathname;
  const entries = [];
  for (const [k, v] of parsed.searchParams.entries()) entries.push([k, v]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const query = entries.map(([k, v]) => `${k}=${v}`).join("&");
  const resource = query ? `${path}?${query}` : path;

  const body = bodyData || "";
  const bodyForMd5 = body.slice(0, 0x19000);
  const bodyMd5 = body ? md5Hex(bodyForMd5) : "";
  const contentLength = body ? String(Buffer.byteLength(body, "utf8")) : "";

  const canonical = [
    String(method).toUpperCase(),
    "application/json",
    "application/json;charset=UTF-8",
    contentLength,
    String(timestamp),
    bodyMd5,
    resource,
  ].join("\n");

  const key = Buffer.from(GATEWAY_SECRET_ONLINE, "base64");
  const digest = createHmac("md5", key).update(canonical, "utf8").digest("base64");
  return `${timestamp}|2|${digest}`;
}

export function defaultClientInfo(deviceId, region = DEFAULT_REGION) {
  const id = deviceId || `86820305${String(randomInt(1000000, 9999999))}`;
  const profile = REGION_PROFILES[region] || REGION_PROFILES[DEFAULT_REGION];
  return {
    package_name: "com.community.oneroom",
    version_name: "4.0.02",
    version_code: 50020126,
    os: "android",
    os_version: "14",
    install_ch: "ps",
    device_id: id,
    install_store: "ps",
    gaid: "",
    brand: "Google",
    model: "Pixel 6",
    system_language: "en",
    net: "wifi",
    region,
    timezone: profile.timezone,
    sp_code: profile.sp_code,
  };
}

export function isTrapStreamUrl(url) {
  if (!url || typeof url !== "string") return false;
  const lower = url.toLowerCase();
  if (lower.includes("macdn.aoneroom.com") && lower.includes("/other/")) return true;
  return TRAP_MARKERS.some((marker) => lower.includes(marker));
}

export function parseDurationSeconds(value, rawSeconds) {
  if (Number.isFinite(Number(rawSeconds)) && Number(rawSeconds) > 0) {
    return Math.round(Number(rawSeconds));
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const h = /(\d+)\s*h/i.exec(value);
  const m = /(\d+)\s*m/i.exec(value);
  const s = /(\d+)\s*s/i.exec(value);
  if (h || m || s) {
    const total = Number(h?.[1] || 0) * 3600 + Number(m?.[1] || 0) * 60 + Number(s?.[1] || 0);
    return total > 0 ? total : undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num * 60) : undefined;
}

function normalizeImageUrl(raw) {
  if (!raw) return undefined;
  const url = typeof raw === "string" ? raw : raw?.url;
  if (!url || typeof url !== "string") return undefined;
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

export function mapMovieBoxSubject(req, c, raw, art) {
  const item = raw?.subject && typeof raw.subject === "object" ? raw.subject : raw;
  const sid = String(item?.subjectId || item?.id || "").trim();
  if (!sid || sid === "0") return null;

  const subjectType = Number(item?.subjectType ?? item?.type ?? 1);
  const isSeries = subjectType === 2 || subjectType === 6;
  const title = plainText(
    item?.title || item?.name || item?.subjectName || item?.showTitle || "Untitled",
  );
  const coverUrl =
    normalizeImageUrl(item?.cover) ||
    normalizeImageUrl(item?.poster) ||
    normalizeImageUrl(item?.image) ||
    normalizeImageUrl(item?.thumbnail);
  const backdropUrl =
    normalizeImageUrl(item?.stills?.[0]) ||
    normalizeImageUrl(item?.preVideoCover) ||
    coverUrl;

  const genre = plainText(item?.genre || "");
  const rating = item?.imdbRatingValue ? `★ ${item.imdbRatingValue}` : "";
  const firstGenre = genre ? genre.split(",")[0].trim() : "";
  const categoryLabel = [firstGenre, rating].filter(Boolean).join(" · ") || undefined;
  const yearMatch = /\b(19\d{2}|20\d{2})\b/.exec(String(item?.releaseDate || item?.year || ""));

  return {
    id: sid,
    connectionId: c.id,
    source: "MovieBox Pro",
    providerType: "moviebox",
    type: isSeries ? "series" : "movie",
    contentKind: isSeries ? "series" : "movie",
    title,
    description: plainText(item?.description || ""),
    year: yearMatch?.[1],
    duration: parseDurationSeconds(item?.duration, item?.durationSeconds),
    category: firstGenre || undefined,
    categoryLabel,
    subtitle: genre || plainText(item?.countryName || "") || undefined,
    poster: coverUrl ? art(req, c, coverUrl) : undefined,
    backdrop: backdropUrl ? art(req, c, backdropUrl) : undefined,
    artwork: "poster",
  };
}

export function createMovieBoxClient({ fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;

  function sessionState(c) {
    if (c.config?.token) {
      return {
        token: c.config.token,
        userId: c.config.userId || "",
        deviceId: c.config.deviceId || "868203051234567",
      };
    }
    let cached = guestSessions.get(c.id);
    if (!cached) {
      cached = {
        token: "",
        userId: "",
        deviceId: c.config?.deviceId || "868203051234567",
        bootstrapped: false,
      };
      guestSessions.set(c.id, cached);
    }
    return cached;
  }

  async function rawRequest(c, method, endpoint, { params = {}, data = null, timeout = 15000, baseUrl } = {}) {
    const base = (baseUrl || c.config?.baseUrl || regionProfile(c).hosts[0] || DEFAULT_BASE_URL).replace(/\/$/, "");
    const parsedBase = validateRemoteUrl(base);
    const state = sessionState(c);
    const allParams = { host: parsedBase.hostname, ...params };
    const sorted = Object.keys(allParams)
      .sort()
      .map((k) => `${k}=${allParams[k]}`)
      .join("&");

    const buildUrl = (ep) => `${base}${ep}${sorted ? `?${sorted}` : ""}`;
    const bodyStr = data != null ? JSON.stringify(data) : "";
    const ts = Date.now();

    const makeHeaders = (targetUrl) => {
      const headers = {
        "User-Agent": "MovieBox/4.0.02 (Android 14; Pixel 6)",
        Accept: "application/json",
        "Content-Type": "application/json;charset=UTF-8",
        "X-M-Version": "4.0.02",
        Referer: `${base}/`,
        "X-Sign-Version": "2.0",
        "X-Client-Token": generateClientToken(ts),
        "X-Client-Info": JSON.stringify(defaultClientInfo(state.deviceId, c.config?.region || DEFAULT_REGION)),
        "X-Client-Status": state.token ? "0" : "1",
        "X-Play-Mode": "2",
        appid: "4U01pxRu278GqCZKY9",
        region: c.config?.region || DEFAULT_REGION,
        lang: "en",
        os: "android",
        "X-Timestamp": String(ts),
        "x-tr-signature": generateTrSignature(method, targetUrl, bodyStr, ts),
      };
      if (state.token) headers.Authorization = `Bearer ${state.token}`;
      return headers;
    };

    const send = async (ep) => {
      const targetUrl = buildUrl(ep);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        return await doFetch(targetUrl, {
          method,
          headers: makeHeaders(targetUrl),
          ...(bodyStr && ["POST", "PUT"].includes(method.toUpperCase()) ? { body: bodyStr } : {}),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let response = await send(endpoint);
    if (response.status === 404) {
      const alt = endpoint.startsWith("/wefeed-mobile-bff")
        ? endpoint.replace("/wefeed-mobile-bff", "")
        : `/wefeed-mobile-bff${endpoint}`;
      if (alt) response = await send(alt);
    }

    const xUser = response.headers?.get?.("x-user");
    if (xUser && !c.config?.token) {
      try {
        const parsed = JSON.parse(xUser);
        if (parsed.token) {
          state.token = parsed.token;
          state.userId = String(parsed.userId || parsed.uid || state.userId || "");
          state.bootstrapped = true;
        }
      } catch {
        /* ignore malformed x-user */
      }
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      if (text.trim().toLowerCase() === "ok") return { code: 0, msg: "ok", data: {} };
      throw providerError(`MovieBox API returned HTTP ${response.status}.`, 502);
    }
  }

  async function ensureGuest(c) {
    const state = sessionState(c);
    if (state.token || state.bootstrapped) return;
    state.bootstrapped = true;
    try {
      const res = await rawRequest(c, "POST", "/wefeed-mobile-bff/user-api/visitor-login", {
        data: {},
      });
      if (res?.code === 0 && res.data?.token) {
        state.token = res.data.token;
        state.userId = String(res.data.userId || res.data.uid || "");
      }
    } catch {
      /* visitor-login is best-effort; x-user header also issues guest tokens */
    }
  }

  async function request(c, method, endpoint, options = {}) {
    await ensureGuest(c);
    try {
      return await rawRequest(c, method, endpoint, options);
    } catch (err) {
      if (c.config?.baseUrl) throw err;
      const hosts = regionProfile(c).hosts;
      for (const fallback of hosts) {
        if (fallback === hosts[0]) continue;
        try {
          return await rawRequest(c, method, endpoint, { ...options, baseUrl: fallback });
        } catch {
          /* try next mirror */
        }
      }
      throw err;
    }
  }

  async function loginAccount(c, account, password) {
    const trimmed = String(account || "").trim();
    if (!trimmed || !password) throw providerError("Enter your MovieBox email/phone and password.");
    const isEmail = trimmed.includes("@");
    const payload = {
      password: md5Hex(password),
      package_name: "com.community.oneroom",
      authType: isEmail ? 1 : 0,
      type: 0,
      ...(isEmail ? { mail: trimmed } : { phone: trimmed }),
    };
    const res = await rawRequest(c, "POST", "/wefeed-mobile-bff/user-api/login", { data: payload });
    if (![0, 200].includes(res?.code) || !res?.data?.token) {
      throw providerError(res?.msg || res?.message || "MovieBox rejected these credentials.", 401);
    }
    return {
      token: res.data.token,
      userId: String(res.data.userId || res.data.uid || ""),
      userInfo: {
        nickname: res.data.nickname || trimmed,
        avatar: res.data.avatar || "",
        email: res.data.mail || (isEmail ? trimmed : ""),
      },
    };
  }

  // MovieBox dropped password login in favour of an emailed/SMS verification
  // code. Step 1: ask MovieBox to send the code to the account.
  async function requestLoginCode(c, account) {
    const trimmed = String(account || "").trim();
    if (!trimmed) throw providerError("Enter your MovieBox email or phone.");
    const isEmail = trimmed.includes("@");
    const payload = {
      package_name: "com.community.oneroom",
      authType: isEmail ? 1 : 0,
      type: 2, // 1 = Register, 2 = Login, 3 = Reset
      ...(isEmail ? { mail: trimmed } : { phone: trimmed }),
    };
    const res = await request(c, "POST", "/wefeed-mobile-bff/user-api/get-sms-code", { data: payload });
    if (![0, 200].includes(res?.code)) {
      throw providerError(res?.msg || res?.message || "MovieBox could not send a verification code. Check the email or phone and try again.", 400);
    }
    return { sent: true, channel: isEmail ? "email" : "phone" };
  }

  // Step 2: check-sms-code validates the code (confirmed: returns code 0). The
  // session token comes back in its body or is issued through the x-user
  // response header (rawRequest promotes that into the session state).
  async function verifyLoginCode(c, account, code) {
    const trimmed = String(account || "").trim();
    const otp = String(code || "").trim();
    if (!trimmed || !otp) throw providerError("Enter your MovieBox email/phone and the verification code.");
    const isEmail = trimmed.includes("@");
    const identity = isEmail ? { mail: trimmed } : { phone: trimmed };
    const base = { package_name: "com.community.oneroom", authType: isEmail ? 1 : 0, ...identity };
    const before = sessionState(c).token;
    const check = await request(c, "POST", "/wefeed-mobile-bff/user-api/check-sms-code", {
      data: { ...base, type: 2, verificationCode: otp },
    });
    const d = check?.data || {};
    const bodyToken = d.token || d.accessToken || d.jwt || d.userToken || d.sessionToken || d.authToken;
    // x-user may have promoted the guest session to a user token during the call.
    const after = sessionState(c).token;
    const promotedToken = after && after !== before ? after : null;
    const token = bodyToken || promotedToken;
    if ([0, 200].includes(check?.code) && token) {
      return {
        token,
        userId: String(d.userId || d.uid || sessionState(c).userId || ""),
        userInfo: {
          nickname: d.nickname || d.userName || trimmed,
          avatar: d.avatar || "",
          email: d.mail || (isEmail ? trimmed : ""),
        },
      };
    }
    // Temporary diagnostic: field names + value types only, never the values.
    const shape = Object.entries(d).map(([k, v]) => `${k}:${typeof v === "string" ? "str" + v.length : Array.isArray(v) ? "arr" : typeof v}`).join(",") || "none";
    throw providerError(`check-sms-code code=${check?.code} msg=${check?.msg || check?.message || "?"} bodyFields=[${shape}] xUserPromoted=${promotedToken ? "yes" : "no"}`, 401);
  }

  return { request, loginAccount, requestLoginCode, verifyLoginCode };
}

function extractSubjects(data) {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.subjects)) return data.subjects;
  if (Array.isArray(data.results)) {
    const out = [];
    for (const group of data.results) {
      if (Array.isArray(group?.subjects)) out.push(...group.subjects);
      else if (Array.isArray(group?.items)) out.push(...group.items);
      else if (group?.subjectId || group?.id) out.push(group);
    }
    return out;
  }
  return [];
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function parseEpisodeItemId(rawId) {
  const parts = String(rawId || "").split(":");
  if (parts.length === 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) {
    return { subjectId: parts[0], season: Number(parts[1]), episode: Number(parts[2]), isEpisode: true };
  }
  return { subjectId: parts[0], season: 0, episode: 0, isEpisode: false };
}

function normalizeStreamEntry(entry, fallbackCookie = "") {
  const url = entry?.url || entry?.resourceLink || entry?.downloadUrl || "";
  if (!url) return null;
  const rawRes = entry?.resolutions || entry?.resolution || entry?.quality || "";
  const qualityLabel = /^\d+$/.test(String(rawRes)) ? `${rawRes}p` : String(rawRes || "Auto");
  return {
    id: String(entry?.id || entry?.resourceId || qualityLabel),
    url,
    quality: qualityLabel,
    codec: String(entry?.codecName || entry?.codec || "").toLowerCase(),
    format: String(entry?.format || (url.includes(".m3u8") ? "HLS" : "MP4")).toUpperCase(),
    signCookie: entry?.signCookie || fallbackCookie || "",
    duration: Number(entry?.duration || 0) || undefined,
  };
}

function scoreStream(st) {
  const u = st.url.toLowerCase();
  const isHevc = st.codec.includes("hevc") || st.codec.includes("265") || u.includes("h265") || u.includes("x265") || u.includes("hev1");
  const isMp4 = u.includes(".mp4") || st.format === "MP4";
  const isHls = u.includes(".m3u8") || st.format === "HLS";
  const resNum = parseInt(st.quality, 10) || 720;
  let score = 0;
  if (isHevc) score += 10000;
  if (isMp4) score += 0;
  else if (isHls) score += 100;
  else score += 500;
  score -= Math.min(resNum, 2160) / 100;
  return score;
}

export function createMovieBoxService({ client, art, media, cached, cacheKey }) {
  async function fetchStreams(c, subjectId, season, episode, isSeries) {
    const se = isSeries ? Math.max(1, season || 1) : undefined;
    const ep = isSeries ? Math.max(1, episode || 1) : undefined;

    const [playV2Res, r2Res, detailRes] = await Promise.allSettled([
      client.request(c, "GET", "/wefeed-mobile-bff/subject-api/play-info/v2", {
        params: { subjectId, ...(se ? { se } : {}), ...(ep ? { ep } : {}) },
      }),
      client.request(c, "GET", "/wefeed-mobile-bff/subject-api/resource/v2", {
        params: {
          subjectId,
          page: 1,
          perPage: 20,
          all: 0,
          startPosition: 1,
          endPosition: 1,
          pagerMode: 2,
          resolution: 0,
          isVip: "true",
          ...(isSeries ? { se: se || 1, epFrom: ep || 1, epTo: ep || 1 } : {}),
        },
      }),
      client.request(c, "GET", "/wefeed-mobile-bff/subject-api/get", {
        params: { subjectId },
      }),
    ]);

    let playData = playV2Res.status === "fulfilled" ? playV2Res.value?.data || {} : {};
    let rawStreams = playData.streams || playData.streamList || [];
    let signCookie = playV2Res.status === "fulfilled" ? (playV2Res.value?.signCookie || playData.signCookie || "") : "";

    if (!rawStreams.length) {
      const legacy = await client.request(c, "GET", "/wefeed-mobile-bff/subject-api/play-info", {
        params: { subjectId, se: se || 1, ep: ep || 1 },
      }).catch(() => null);
      if (legacy?.data) {
        playData = legacy.data;
        rawStreams = playData.streamList || playData.streams || [];
        signCookie = legacy.signCookie || playData.signCookie || signCookie;
      }
    }

    const candidates = [];
    for (const st of rawStreams) {
      const normalized = normalizeStreamEntry(st, signCookie);
      if (normalized) candidates.push(normalized);
    }

    const r2List = r2Res.status === "fulfilled" ? r2Res.value?.data?.list || [] : [];
    for (const rItem of r2List) {
      const normalized = normalizeStreamEntry(rItem, signCookie);
      if (normalized) candidates.push(normalized);
    }

    const detailData = detailRes.status === "fulfilled" ? detailRes.value?.data || {} : {};
    const detectors = detailData.resourceDetectors || [];
    for (const det of detectors) {
      const detCookie = det.signCookie || signCookie;
      const resList = Array.isArray(det.resolutionList) && det.resolutionList.length
        ? det.resolutionList
        : [det];
      for (const rItem of resList) {
        if (isSeries) {
          const itemSe = rItem.se ?? rItem.season;
          const itemEp = rItem.ep ?? rItem.episode;
          if (itemSe != null && itemEp != null && (Number(itemSe) !== Number(se) || Number(itemEp) !== Number(ep))) {
            continue;
          }
        }
        const normalized = normalizeStreamEntry(
          {
            ...rItem,
            url: rItem.downloadUrl || rItem.resourceLink || rItem.url,
            codecName: rItem.codecName || det.codecName,
            resourceId: rItem.resourceId || det.resourceId,
          },
          detCookie,
        );
        if (normalized) candidates.push(normalized);
      }
    }

    const resolved = [];
    for (const cand of candidates) {
      if (!isTrapStreamUrl(cand.url)) {
        resolved.push(cand);
        continue;
      }
      if (cand.id && /^\d+$/.test(cand.id)) {
        try {
          const rec = await client.request(c, "GET", "/wefeed-mobile-bff/subject-api/resource-position/v2", {
            params: {
              subjectId,
              resourceId: cand.id,
              failUrl: cand.url,
              failCode: "404",
              resourceNum: "0",
              isVip: "true",
            },
          });
          const recItem = rec?.data?.list?.[0];
          const realUrl = recItem?.resourceLink || recItem?.downloadUrl || recItem?.url;
          if (realUrl && !isTrapStreamUrl(realUrl)) {
            resolved.push(normalizeStreamEntry({ ...recItem, url: realUrl }, cand.signCookie));
          }
        } catch {
          /* skip unrecoverable trap stream */
        }
      }
    }

    // Deduplicate by URL and sort H.264 MP4/HLS first
    const unique = [...new Map(resolved.filter(Boolean).map((s) => [s.url, s])).values()];
    unique.sort((a, b) => scoreStream(a) - scoreStream(b));

    // Fetch external captions
    const resourceId = detectors[0]?.resourceId || subjectId;
    const extCapsRes = await client
      .request(c, "GET", "/wefeed-mobile-bff/subject-api/get-ext-captions", {
        params: { subjectId, resourceId, episode: isSeries ? ep || 1 : 0 },
      })
      .catch(() => null);
    const rawSubs = [
      ...(playData.subTitleList || []),
      ...(extCapsRes?.data?.extCaptions || extCapsRes?.data?.list || []),
    ];
    const subtitles = [...new Map(
      rawSubs
        .filter((s) => s?.url)
        .map((s, idx) => [
          s.url,
          {
            id: `mb-sub-${s.id || idx}`,
            label: plainText(s.lanName || s.languageName || s.language || s.lan || "Subtitles"),
            language: String(s.lan || s.language || "en").slice(0, 12),
            url: s.url,
          },
        ]),
    ).values()];

    return { streams: unique, subtitles, detail: detailData };
  }

  async function resolveEpisodes(req, c, itemId) {
    const { subjectId } = parseEpisodeItemId(itemId);
    const [seasonRes, detailRes] = await Promise.all([
      client.request(c, "GET", "/wefeed-mobile-bff/subject-api/season-info", {
        params: { subjectId },
      }),
      client.request(c, "GET", "/wefeed-mobile-bff/subject-api/get", {
        params: { subjectId },
      }).catch(() => null),
    ]);
    const detail = detailRes?.data || {};
    const poster = normalizeImageUrl(detail.cover) ? art(req, c, normalizeImageUrl(detail.cover)) : undefined;
    const backdrop = normalizeImageUrl(detail.stills?.[0]) ? art(req, c, normalizeImageUrl(detail.stills[0])) : poster;
    const seasons = seasonRes?.data?.seasons || [];
    const items = [];
    for (const s of seasons) {
      const se = Number(s.se || s.seasonNumber || 1);
      const maxEp = Number(s.maxEp || s.episodeCount || 0);
      if (Array.isArray(s.episodes) && s.episodes.length) {
        for (const ep of s.episodes) {
          const epNum = Number(ep.ep || ep.episodeNumber || ep.episode || 1);
          items.push({
            id: `${subjectId}:${se}:${epNum}`,
            seriesId: subjectId,
            connectionId: c.id,
            source: "MovieBox Pro",
            providerType: "moviebox",
            type: "episode",
            title: plainText(ep.title || ep.name || `Episode ${epNum}`),
            description: plainText(ep.description || detail.description || ""),
            seasonNumber: se,
            episodeNumber: epNum,
            duration: parseDurationSeconds(ep.duration, ep.durationSeconds) || parseDurationSeconds(detail.duration, detail.durationSeconds),
            poster,
            backdrop,
            artwork: "poster",
          });
        }
      } else if (maxEp > 0) {
        for (let epNum = 1; epNum <= maxEp; epNum++) {
          items.push({
            id: `${subjectId}:${se}:${epNum}`,
            seriesId: subjectId,
            connectionId: c.id,
            source: "MovieBox Pro",
            providerType: "moviebox",
            type: "episode",
            title: `Episode ${epNum}`,
            description: plainText(detail.description || ""),
            seasonNumber: se,
            episodeNumber: epNum,
            duration: parseDurationSeconds(detail.duration, detail.durationSeconds),
            poster,
            backdrop,
            artwork: "poster",
          });
        }
      }
    }
    return items;
  }

  async function resolvePlaybackOptions(req, c, itemId, kind) {
    const parsed = parseEpisodeItemId(itemId);
    const isSeries = kind === "episode" || kind === "series" || parsed.isEpisode;
    const { streams, subtitles, detail } = await fetchStreams(
      c,
      parsed.subjectId,
      parsed.season,
      parsed.episode,
      isSeries,
    );
    const mappedItem = detail?.subjectId ? mapMovieBoxSubject(req, c, detail, art) : undefined;
    const qualities = [...new Map(
      streams.map((s) => [s.quality.toLowerCase(), { id: s.quality.toLowerCase(), label: s.quality }]),
    ).values()];
    const sources = streams.map((s, idx) => ({
      id: `mb-src-${idx}`,
      label: `${s.quality} · ${s.format}${s.codec ? ` (${s.codec.toUpperCase()})` : ""}`,
      description: s.codec.includes("hevc") || s.codec.includes("265") ? "H.265 / HEVC" : "H.264 compatible",
      addon: "MovieBox Pro",
    }));
    return {
      ...(mappedItem && !parsed.isEpisode ? { item: mappedItem } : {}),
      audio: [],
      subtitles: subtitles.map((s) => ({ id: s.id, label: s.label, language: s.language })),
      qualities,
      sources,
    };
  }

  async function resolvePlayback(req, c, itemId, kind, query = {}) {
    const parsed = parseEpisodeItemId(itemId);
    const isSeries = kind === "episode" || kind === "series" || parsed.isEpisode;
    const { streams, subtitles } = await fetchStreams(
      c,
      parsed.subjectId,
      parsed.season,
      parsed.episode,
      isSeries,
    );
    if (!streams.length) {
      throw providerError("No playable MovieBox streams were found for this title.", 404);
    }

    let chosen = streams[0];
    if (query.sourceId && /^mb-src-\d+$/.test(query.sourceId)) {
      const idx = Number(query.sourceId.slice(7));
      if (streams[idx]) chosen = streams[idx];
    } else if (query.qualityId && query.qualityId !== "auto") {
      const match = streams.find((s) => s.quality.toLowerCase() === String(query.qualityId).toLowerCase());
      if (match) chosen = match;
    }

    const headers = {
      "User-Agent": "ExoPlayerLib/2.18.7",
      Referer: "https://www.movieboxpro.app/",
      ...(chosen.signCookie ? { Cookie: chosen.signCookie } : {}),
    };
    const isHls = chosen.url.toLowerCase().includes(".m3u8");
    const type = isHls ? "hls" : "video";

    return {
      provider: "moviebox",
      url: media.register(req, c, {
        url: chosen.url,
        headers,
        kind: type,
      }),
      type,
      ...(isHls ? {} : { streamKind: "direct-file" }),
      subtitles: subtitles.map((s) => ({
        id: s.id,
        label: s.label,
        language: s.language,
        url: media.register(req, c, {
          url: s.url,
          headers: {
            "User-Agent": "ExoPlayerLib/2.18.7",
            Referer: "https://www.movieboxpro.app/",
          },
          kind: "subtitle",
        }),
      })),
    };
  }

  async function browseCatalog(req, c, { tab = "trending", page = 1, q = "", kind = "all" } = {}) {
    if (q) {
      const subjectType = kind === "movie" ? 1 : kind === "series" ? 2 : 0;
      const res = await client.request(c, "POST", "/wefeed-mobile-bff/subject-api/search/v2", {
        data: { keyword: q, page, perPage: 24, pageSize: 24, subjectType, type: subjectType, q },
      });
      const items = dedupeItems(
        extractSubjects(res?.data).map((s) => mapMovieBoxSubject(req, c, s, art)).filter(Boolean),
      );
      return { items, hasMore: Boolean(res?.data?.pager?.hasMore) };
    }

    if (tab === "rankings") {
      const res = await client.request(c, "GET", "/wefeed-mobile-bff/tab/ranking-list", {
        params: { tabId: 1, categoryType: "all", page, perPage: 24 },
      });
      const items = dedupeItems(
        extractSubjects(res?.data).map((s) => mapMovieBoxSubject(req, c, s, art)).filter(Boolean),
      );
      return { items, hasMore: Boolean(res?.data?.pager?.hasMore) };
    }

    if (tab === "anime") {
      const res = await client.request(c, "GET", "/wefeed-mobile-bff/subject-api/filter-items", {
        params: { page, pageSize: 24, genre: "Animation" },
      });
      const items = dedupeItems(
        extractSubjects(res?.data).map((s) => mapMovieBoxSubject(req, c, s, art)).filter(Boolean),
      );
      return { items, hasMore: Boolean(res?.data?.pager?.hasMore) };
    }

    const typeMap = { movies: "movie", movie: "movie", series: "tv", tv: "tv", trending: "trending" };
    const genreType = typeMap[tab] || (kind === "movie" ? "movie" : kind === "series" ? "tv" : "trending");
    const res = await client.request(c, "POST", "/wefeed-mobile-bff/subject-api/genre-top", {
      data: { type: genreType, page, perPage: 24 },
    });
    const items = dedupeItems(
      extractSubjects(res?.data).map((s) => mapMovieBoxSubject(req, c, s, art)).filter(Boolean),
    );
    return { items, hasMore: Boolean(res?.data?.pager?.hasMore) };
  }

  async function discoverShelves(req, c) {
    const key = cacheKey(c) + ":discover";
    const raw = await cached(
      key,
      async () => {
        const [trending, daily, movies, series, rankings, suggestions] = await Promise.allSettled([
          client.request(c, "POST", "/wefeed-mobile-bff/subject-api/genre-top", { data: { type: "trending", page: 1, perPage: 16 } }),
          client.request(c, "POST", "/wefeed-mobile-bff/subject-api/daily-movie-rec", { data: { page: 1, pageSize: 16 } }),
          client.request(c, "POST", "/wefeed-mobile-bff/subject-api/genre-top", { data: { type: "movie", page: 1, perPage: 16 } }),
          client.request(c, "POST", "/wefeed-mobile-bff/subject-api/genre-top", { data: { type: "tv", page: 1, perPage: 16 } }),
          client.request(c, "GET", "/wefeed-mobile-bff/tab/ranking-list", { params: { tabId: 1, categoryType: "all", page: 1, perPage: 16 } }),
          client.request(c, "GET", "/wefeed-mobile-bff/subject-api/search-rank", { params: { page: 1, pageSize: 10 } }),
        ]);
        return {
          trending: trending.status === "fulfilled" ? extractSubjects(trending.value?.data) : [],
          daily: daily.status === "fulfilled" ? extractSubjects(daily.value?.data) : [],
          movies: movies.status === "fulfilled" ? extractSubjects(movies.value?.data) : [],
          series: series.status === "fulfilled" ? extractSubjects(series.value?.data) : [],
          rankings: rankings.status === "fulfilled" ? extractSubjects(rankings.value?.data) : [],
          suggestions: suggestions.status === "fulfilled"
            ? extractSubjects(suggestions.value?.data).map((s) => plainText(s.title || s.keyword || s.name || "")).filter(Boolean).slice(0, 8)
            : [],
        };
      },
      300,
    );

    const mapList = (list) => dedupeItems(list.map((s) => mapMovieBoxSubject(req, c, s, art)).filter(Boolean));
    const shelves = [
      { id: "trending", title: "Trending on MovieBox", items: mapList(raw.trending), tab: "trending" },
      { id: "daily", title: "Daily Picks", items: mapList(raw.daily), tab: "trending" },
      { id: "movies", title: "Popular Movies", items: mapList(raw.movies), tab: "movies" },
      { id: "series", title: "Popular TV Series", items: mapList(raw.series), tab: "series" },
      { id: "rankings", title: "Top Rankings", items: mapList(raw.rankings), tab: "rankings" },
    ].filter((s) => s.items.length > 0);

    return { shelves, suggestions: raw.suggestions };
  }

  return {
    resolveEpisodes,
    resolvePlaybackOptions,
    resolvePlayback,
    browseCatalog,
    discoverShelves,
  };
}

export function registerMovieBoxRoutes(app, { ctx, connection, route, art, media, cached, cacheKey, dependencies = {} }) {
  const client = dependencies.movieboxClient || createMovieBoxClient();
  const service = createMovieBoxService({ client, art, media, cached, cacheKey });

  app.post("/api/moviebox/:connectionId/request-code", ctx.requireConnectionManager || ((_r, _s, n) => n()), route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    const { account } = req.body || {};
    res.json(await client.requestLoginCode(c, account));
  }));

  app.post("/api/moviebox/:connectionId/login", ctx.requireConnectionManager || ((_r, _s, n) => n()), route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    const { account, code, password } = req.body || {};
    const auth = code
      ? await client.verifyLoginCode(c, account, code)
      : await client.loginAccount(c, account, password);
    const updated = ctx.saveConnection(req, {
      id: c.id,
      type: c.type,
      name: c.name,
      config: {
        ...c.config,
        authMode: "account",
        account: String(account).trim(),
        token: auth.token,
        userId: auth.userId,
        userInfo: auth.userInfo,
      },
    });
    res.json({ connection: updated, user: auth.userInfo });
  }));

  app.post("/api/moviebox/:connectionId/logout", ctx.requireConnectionManager || ((_r, _s, n) => n()), route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    const { token: _t, userId: _u, userInfo: _ui, account: _a, ...rest } = c.config || {};
    const updated = ctx.saveConnection(req, {
      id: c.id,
      type: c.type,
      name: c.name,
      config: { ...rest, authMode: "guest" },
    });
    guestSessions.delete(c.id);
    res.json({ connection: updated });
  }));

  app.get("/api/moviebox/:connectionId/discover", route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    res.json(await service.discoverShelves(req, c));
  }));

  app.get("/api/moviebox/:connectionId/browse", route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    const tab = String(req.query.tab || "trending");
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    res.json(await service.browseCatalog(req, c, { tab, page }));
  }));

  app.get("/api/moviebox/:connectionId/search", route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    const q = String(req.query.q || "").trim().slice(0, 200);
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const kind = String(req.query.kind || "all");
    if (!q) return res.json({ items: [], hasMore: false });
    res.json(await service.browseCatalog(req, c, { q, page, kind }));
  }));

  app.get("/api/moviebox/:connectionId/detail/:subjectId", route(async (req, res) => {
    const c = connection(req, req.params.connectionId, "moviebox");
    const subjectId = String(req.params.subjectId || "").trim();
    const [detailRes, relatedRes] = await Promise.allSettled([
      client.request(c, "GET", "/wefeed-mobile-bff/subject-api/get", { params: { subjectId } }),
      client.request(c, "GET", "/wefeed-mobile-bff/subject-api/related", { params: { subjectId } }),
    ]);
    const detail = detailRes.status === "fulfilled" ? detailRes.value?.data : null;
    if (!detail?.subjectId) throw providerError("MovieBox title was not found.", 404);
    const item = mapMovieBoxSubject(req, c, detail, art);
    const cast = (detail.staffList || []).slice(0, 12).map((actor) => ({
      name: plainText(actor.name || actor.actorName || "Unknown"),
      role: plainText(actor.character || actor.role || "Cast"),
      avatar: normalizeImageUrl(actor.avatarUrl || actor.avatar)
        ? art(req, c, normalizeImageUrl(actor.avatarUrl || actor.avatar))
        : undefined,
    }));
    const related = relatedRes.status === "fulfilled"
      ? dedupeItems(extractSubjects(relatedRes.value?.data).map((s) => mapMovieBoxSubject(req, c, s, art)).filter(Boolean)).slice(0, 12)
      : [];
    res.json({ item, cast, related, rating: detail.imdbRatingValue || null });
  }));

  return service;
}
