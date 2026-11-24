import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createMovieBoxClient,
  createMovieBoxService,
  generateClientToken,
  generateTrSignature,
  isTrapStreamUrl,
  md5Hex,
  parseDurationSeconds,
} from "../server/moviebox.js";

test("MovieBox signing & helpers match internal protocol", () => {
  assert.equal(md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
  const ct = generateClientToken(1700000000123);
  assert.equal(ct, `1700000000123,${md5Hex("3210000000071")}`);

  const sig = generateTrSignature(
    "POST",
    "https://apig.inmoviebox.com/wefeed-mobile-bff/subject-api/search/v2?z=2&a=1",
    '{"q":"test"}',
    1700000000123,
  );
  const [ts, ver, mac] = sig.split("|");
  assert.equal(ts, "1700000000123");
  assert.equal(ver, "2");
  const expectedCanonical = [
    "POST",
    "application/json",
    "application/json;charset=UTF-8",
    "12",
    "1700000000123",
    md5Hex('{"q":"test"}'),
    "/wefeed-mobile-bff/subject-api/search/v2?a=1&z=2",
  ].join("\n");
  const expectedMac = createHmac("md5", Buffer.from("76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O", "base64"))
    .update(expectedCanonical, "utf8")
    .digest("base64");
  assert.equal(mac, expectedMac);

  assert.equal(isTrapStreamUrl("https://macdn.aoneroom.com/other/2026/10/10/80da52722ee7de7a4303290af6783424.mp4"), true);
  assert.equal(isTrapStreamUrl("https://cdn.example.com/notice.mp4"), true);
  assert.equal(isTrapStreamUrl("https://macdn.hakunaymatata.com/resource/movie.mp4"), false);

  assert.equal(parseDurationSeconds("2h 28m"), 8880);
  assert.equal(parseDurationSeconds("45m"), 2700);
  assert.equal(parseDurationSeconds(undefined, 3600), 3600);
});

test("MovieBox client bootstraps guest token and service resolves search, episodes, and trap-free streams", async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers });
    const parsed = new URL(url);
    const jsonRes = (body, headers = {}) => ({
      status: 200,
      headers: { get: (k) => headers[k.toLowerCase()] || null },
      text: async () => JSON.stringify(body),
    });

    if (parsed.pathname.endsWith("/user-api/visitor-login")) {
      return jsonRes({ code: 0, data: { token: "guest-jwt-1", userId: "1001" } });
    }
    if (parsed.pathname.endsWith("/subject-api/search/v2")) {
      return jsonRes({
        code: 0,
        data: {
          pager: { hasMore: true },
          results: [
            {
              topicType: "SUBJECT",
              subjects: [
                {
                  subjectId: "555",
                  subjectType: 1,
                  title: "Inception",
                  releaseDate: "2010-07-16",
                  duration: "2h 28m",
                  genre: "Sci-Fi, Action",
                  imdbRatingValue: "8.8",
                  cover: { url: "https://pbcdn.aoneroom.com/poster.jpg" },
                },
              ],
            },
          ],
        },
      });
    }
    if (parsed.pathname.endsWith("/subject-api/season-info")) {
      return jsonRes({
        code: 0,
        data: {
          seasons: [
            { se: 1, maxEp: 2 },
            { se: 2, episodes: [{ ep: 1, title: "Premiere", durationSeconds: 2400 }] },
          ],
        },
      });
    }
    if (parsed.pathname.endsWith("/subject-api/get")) {
      return jsonRes({
        code: 0,
        data: {
          subjectId: "555",
          subjectType: 1,
          title: "Inception",
          cover: { url: "https://pbcdn.aoneroom.com/poster.jpg" },
          resourceDetectors: [
            {
              resourceId: "999",
              codecName: "avc",
              signCookie: "signCookie=abc",
              resolutionList: [
                { resolution: 1080, downloadUrl: "https://macdn.hakunaymatata.com/resource/inception-1080.mp4" },
              ],
            },
          ],
        },
      });
    }
    if (parsed.pathname.endsWith("/subject-api/play-info/v2")) {
      return jsonRes({
        code: 0,
        data: {
          streams: [
            { id: "trap-1", url: "https://macdn.aoneroom.com/other/80da52722ee7de7a4303290af6783424.mp4", resolutions: "480" },
          ],
        },
      });
    }
    if (parsed.pathname.endsWith("/subject-api/resource/v2")) {
      return jsonRes({ code: 0, data: { list: [] } });
    }
    if (parsed.pathname.endsWith("/subject-api/get-ext-captions")) {
      return jsonRes({
        code: 0,
        data: {
          extCaptions: [{ id: "1", lan: "en", lanName: "English", url: "https://pacdn.aoneroom.com/en.srt" }],
        },
      });
    }
    return jsonRes({ code: 0, data: {} });
  };

  const client = createMovieBoxClient({ fetchImpl: fakeFetch });
  const registered = [];
  const service = createMovieBoxService({
    client,
    art: (_req, _c, u) => `art:${u}`,
    media: {
      register: (_req, _c, opts) => {
        registered.push(opts);
        return `/api/media/tok-${registered.length}`;
      },
    },
    cached: async (_k, fn) => fn(),
    cacheKey: (c) => c.id,
  });

  const conn = { id: "mb-1", type: "moviebox", name: "MovieBox Pro", config: {} };

  const search = await service.browseCatalog({}, conn, { q: "Inception", page: 1 });
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].title, "Inception");
  assert.equal(search.items[0].year, "2010");
  assert.equal(search.items[0].duration, 8880);
  assert.equal(search.hasMore, true);

  const episodes = await service.resolveEpisodes({}, conn, "555");
  assert.equal(episodes.length, 3);
  assert.deepEqual(
    episodes.map((e) => e.id),
    ["555:1:1", "555:1:2", "555:2:1"],
  );
  assert.equal(episodes[2].title, "Premiere");

  const playback = await service.resolvePlayback({}, conn, "555", "movie");
  assert.equal(playback.provider, "moviebox");
  assert.equal(playback.type, "video");
  assert.equal(playback.subtitles.length, 1);
  assert.equal(playback.subtitles[0].label, "English");
  assert.equal(registered[0].url, "https://macdn.hakunaymatata.com/resource/inception-1080.mp4");
  assert.equal(registered[0].headers.Cookie, "signCookie=abc");
  assert.equal(registered[0].headers["User-Agent"], "ExoPlayerLib/2.18.7");
  assert.ok(requests.some((r) => r.headers.Authorization === "Bearer guest-jwt-1"));
});

test("MovieBox search flattens grouped results and unwraps info-wrapped subjects", async () => {
  const jsonRes = (body) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const fakeFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/user-api/visitor-login")) return jsonRes({ code: 0, data: { token: "guest" } });
    if (path.endsWith("/subject-api/search/v2")) {
      return jsonRes({
        code: 0,
        data: {
          pager: { hasMore: false },
          items: [
            { title: "Related Sports", subjects: [{ subjectId: "900", subjectType: 1, title: "Sport Clip" }] },
            { title: "", subjects: [{ subjectId: "101", subjectType: 1, title: "The Batman", releaseDate: "2022-03-04" }] },
            { info: { subjectId: "102", subjectType: 2, title: "Batman: The Animated Series" } },
            { title: "Related Music", items: [] },
          ],
        },
      });
    }
    if (path.endsWith("/subject-api/genre-top")) {
      return jsonRes({ code: 0, data: { list: [{ info: { subjectId: "201", subjectType: 2, title: "SEAL Team" }, number: 1 }] } });
    }
    return jsonRes({ code: 0, data: {} });
  };
  const service = createMovieBoxService({
    client: createMovieBoxClient({ fetchImpl: fakeFetch }),
    art: (_req, _c, u) => `art:${u}`,
    media: { register: () => "/api/media/x" },
    cached: async (_k, fn) => fn(),
    cacheKey: (c) => c.id,
  });
  const conn = { id: "mb-2", type: "moviebox", name: "MovieBox Pro", config: {} };

  const search = await service.browseCatalog({}, conn, { q: "batman", page: 1 });
  assert.deepEqual(search.items.map((i) => i.title), ["The Batman", "Batman: The Animated Series", "Sport Clip"]);

  const trending = await service.browseCatalog({}, conn, { tab: "trending", page: 1 });
  assert.deepEqual(trending.items.map((i) => i.title), ["SEAL Team"]);
});
