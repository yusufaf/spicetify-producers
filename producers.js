// NAME: Producers
// AUTHOR: yusufaf
// x-release-please-start-version
// VERSION: 0.1.0
// x-release-please-end-version
// DESCRIPTION: Show each track's producers, from Spotify's own credits, as a column on album and playlist pages.
//
// No build step. Single IIFE. The pure helpers (credits parsing, row matching,
// cache, grid template) run under `node` for testing — see the `module.exports`
// guard in the middle of the file. Everything after that guard touches the DOM.

(function Producers() {
  "use strict";

  //#region Constants

  // x-release-please-start-version
  const PR_VERSION = "0.1.0";
  // x-release-please-end-version

  const PR_GITHUB_REPO = "yusufaf/spicetify-producers";
  const LOG_PREFIX = "[Producers]";

  const CONFIG_KEY = "producers-config";
  const CACHE_KEY = "producers-cache";
  const STYLE_ID = "pr-styles";
  const GRID_STYLE_ID = "pr-grid-styles";

  /** Roles that count as "producer", compared lowercased. Spotify sends English display strings. */
  const PRODUCER_ROLES = ["producer", "co-producer", "studio producer"];

  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const CACHE_MAX_ENTRIES = 5000;
  const CACHE_SAVE_DELAY_MS = 2000;

  const MAX_CONCURRENT = 4;
  const MAX_PER_MINUTE = 120;
  const BACKOFF_BASE_MS = 2000;
  const BACKOFF_MAX_MS = 60000;

  /** Names shown before the "+N" chip. */
  const MAX_VISIBLE_NAMES = 2;

  /** Below this tracklist width there's no room for another column, so producers go inline under the title. */
  const COLUMN_MIN_GRID_WIDTH = 900;

  // A percentage, not fr: Spotify rescales its own fr tracks (e.g. 57fr/14fr) as columns are resized.
  const PRODUCERS_COLUMN_WIDTH = "minmax(160px, 22%)";

  const DEFAULT_CONFIG = { albums: true, playlists: true };

  //#endregion

  //#region Pure: credits parsing

  /**
   * @typedef {Object} Producer
   * @property {string} name
   * @property {string} role       Spotify's role string as sent, e.g. "Producer", "Studio Producer"
   * @property {string|null} uri   spotify:artist:… when the person has an artist page
   */

  /**
   * Picks the producers out of a raw `queryTrackCreditsGroupedModal` response.
   *
   * Contributors live at `data.trackUnion.creditsTrait.contributors.items`, each
   * `{ name, role, roleGroup: { name }, uri, url }`. Keep only roles in
   * PRODUCER_ROLES (case-insensitive), in the order Spotify lists them, and list
   * each person once even if they hold two producer roles. Return [] for any
   * response that doesn't have that shape.
   *
   * @param {any} response
   * @returns {Producer[]}
   */
  function extractProducers(response) {
    const items = response?.data?.trackUnion?.creditsTrait?.contributors?.items;
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    const producers = [];
    for (const item of items) {
      if (!item || typeof item.name !== "string" || typeof item.role !== "string") continue;
      if (!PRODUCER_ROLES.includes(item.role.toLowerCase())) continue;
      // An artist uri identifies a person even if their name is spelled two ways; without one, the name is all we have.
      const id = item.uri || `name:${item.name.toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      producers.push({ name: item.name, role: item.role, uri: item.uri || null });
    }
    return producers;
  }

  /**
   * Groups producers by role for the popover, in PRODUCER_ROLES order, skipping
   * empty groups.
   * @param {Producer[]} producers
   * @returns {{ role: string, people: Producer[] }[]}
   */
  function groupByRole(producers) {
    const groups = [];
    for (const wanted of PRODUCER_ROLES) {
      const people = producers.filter((p) => p.role.toLowerCase() === wanted);
      if (people.length) groups.push({ role: people[0].role, people });
    }
    return groups;
  }

  /**
   * @param {Producer[]} producers
   * @param {number} max
   * @returns {{ shown: Producer[], hiddenCount: number }}
   */
  function splitForDisplay(producers, max = MAX_VISIBLE_NAMES) {
    return { shown: producers.slice(0, max), hiddenCount: Math.max(0, producers.length - max) };
  }

  //#endregion

  //#region Pure: row matching

  /** Formats a duration the way Spotify's tracklist does: seconds floored, "m:ss" or "h:mm:ss". */
  function formatDuration(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  function rowKey(title, durationText) {
    return title.trim().toLowerCase() + "|" + durationText.trim();
  }

  /**
   * @param {{ name: string, durationMs: number, uri: string }[]} tracks
   * @returns {Map<string, string>} rowKey -> track uri. Identical title+duration pairs
   *   are indistinguishable from the row, so the first one wins.
   */
  function buildTrackIndex(tracks) {
    const index = new Map();
    for (const t of tracks) {
      if (!t || !t.name || !t.uri || typeof t.durationMs !== "number") continue;
      const key = rowKey(t.name, formatDuration(t.durationMs));
      if (!index.has(key)) index.set(key, t.uri);
    }
    return index;
  }

  //#endregion

  //#region Pure: grid template

  /**
   * Inserts the producers column right before Spotify's [last] (duration) track.
   * Returns null when the template has no [last] line to anchor on.
   * @param {string} template  Spotify's own --grid-template-columns value
   */
  function withProducersColumn(template, width = PRODUCERS_COLUMN_WIDTH) {
    if (!template || !template.includes("[last]")) return null;
    if (template.includes("[producers]")) return template;
    return template.replace("[last]", `[producers] ${width} [last]`);
  }

  //#endregion

  //#region Pure: cache

  /**
   * LRU cache of track uri -> producers, with a TTL. Map insertion order is the
   * recency order: a hit re-inserts the entry at the end, eviction drops the front.
   */
  function createCache({ ttlMs = CACHE_TTL_MS, maxEntries = CACHE_MAX_ENTRIES, now = () => Date.now() } = {}) {
    /** @type {Map<string, { t: number, p: Producer[] }>} */
    const entries = new Map();

    function get(uri) {
      const e = entries.get(uri);
      if (!e) return undefined;
      if (now() - e.t > ttlMs) {
        entries.delete(uri);
        return undefined;
      }
      entries.delete(uri);
      entries.set(uri, e);
      return e.p;
    }

    function set(uri, producers, t = now()) {
      entries.delete(uri);
      entries.set(uri, { t, p: producers });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    }

    function evictOldest(count) {
      for (let i = 0; i < count && entries.size; i++) entries.delete(entries.keys().next().value);
    }

    /** Compact form for localStorage: [uri, timestamp, [[name, role, artistId|null], …]]. */
    function serialize() {
      const out = [];
      for (const [uri, e] of entries) {
        out.push([uri, e.t, e.p.map((p) => [p.name, p.role, p.uri ? p.uri.split(":")[2] : null])]);
      }
      return JSON.stringify(out);
    }

    function load(json) {
      let rows;
      try {
        rows = JSON.parse(json);
      } catch {
        return;
      }
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 3 || !Array.isArray(row[2])) continue;
        const [uri, t, people] = row;
        if (typeof uri !== "string" || typeof t !== "number" || now() - t > ttlMs) continue;
        if (!people.every((p) => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string")) continue;
        set(uri, people.map(([name, role, id]) => ({ name, role, uri: id ? `spotify:artist:${id}` : null })), t);
      }
    }

    return { get, set, evictOldest, serialize, load, get size() { return entries.size; } };
  }

  //#endregion

  //#region Node/browser dual-environment export

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      PRODUCER_ROLES,
      extractProducers,
      groupByRole,
      splitForDisplay,
      formatDuration,
      rowKey,
      buildTrackIndex,
      withProducersColumn,
      createCache,
    };
  }

  //#endregion

  // Everything below this line touches the DOM / Spicetify APIs and is skipped
  // entirely when this file is `require()`d under Node for testing.
  if (typeof document === "undefined" || typeof window === "undefined") return;

  //#region Selectors
  // Spotify 1.3.x hashes tracklist class names, so only ARIA roles are stable.

  // #main-view on 1.3.x; .Root__main-view on older builds.
  const SEL_MAIN_VIEW = "#main-view, .Root__main-view";
  const SEL_GRID = '[role="grid"][aria-rowcount]:not([aria-label="Your Library"])';
  const SEL_ROW = '[role="row"][aria-rowindex]';
  const SEL_HEADER_CELL = '[role="columnheader"]';
  const SEL_CELL = '[role="gridcell"]';
  const DURATION_RE = /^\d+:\d{2}(:\d{2})?$/;

  //#endregion

  //#region Config

  let config = { ...DEFAULT_CONFIG };

  function loadConfig() {
    try {
      const raw = Spicetify.LocalStorage.get(CONFIG_KEY);
      if (raw) config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (e) {
      console.warn(LOG_PREFIX, "Couldn't read settings, using defaults.", e);
    }
  }

  function saveConfig() {
    Spicetify.LocalStorage.set(CONFIG_KEY, JSON.stringify(config));
  }

  //#endregion

  //#region Cache persistence

  const cache = createCache();
  let saveTimer = null;

  function loadCache() {
    const raw = Spicetify.LocalStorage.get(CACHE_KEY);
    if (raw) cache.load(raw);
  }

  function saveCache() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        Spicetify.LocalStorage.set(CACHE_KEY, cache.serialize());
        return;
      } catch (e) {
        // localStorage is shared with Spotify; on quota errors give back half and retry.
        cache.evictOldest(Math.ceil(cache.size / 2));
      }
    }
    console.warn(LOG_PREFIX, "Couldn't save the credits cache.");
  }

  // Debounced: one write per burst of fetches, not one per track.
  function scheduleCacheSave() {
    if (saveTimer || destroyed) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveCache();
    }, CACHE_SAVE_DELAY_MS);
  }

  function flushCacheSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    saveCache();
  }

  //#endregion

  //#region Credits fetching (rate-limited queue)

  /** @type {string[]} */
  let queue = [];
  /** URIs on rendered rows right now; queued work for anything else is dropped. */
  let wanted = new Set();
  const inFlight = new Set();
  /** Per-track failure counts; after MAX_ATTEMPTS a track shows "—" for the rest of the session (not cached). */
  const attempts = new Map();
  const givenUp = new Set();
  const MAX_ATTEMPTS = 3;
  const startedAt = [];
  let failures = 0;
  let pausedUntil = 0;
  let pumpTimer = null;
  /** Read from the console via window.__producersExtension.stats when checking rate limiting. */
  const stats = { fetched: 0, failed: 0, maxInFlight: 0 };

  async function fetchCredits(uri) {
    const def = Spicetify.GraphQL.Definitions.queryTrackCreditsGroupedModal;
    if (!def) throw new Error("queryTrackCreditsGroupedModal is missing from this Spotify version");
    const res = await Spicetify.GraphQL.Request(def, { trackUri: uri });
    if (res && res.errors && res.errors.length && !(res.data && res.data.trackUnion)) {
      throw new Error(res.errors[0].message || "GraphQL error");
    }
    return extractProducers(res);
  }

  function enqueue(uri) {
    if (!givenUp.has(uri) && cache.get(uri) === undefined && !inFlight.has(uri) && !queue.includes(uri)) queue.push(uri);
    pump();
  }

  function pump() {
    if (pumpTimer || destroyed) return;
    const now = Date.now();
    while (startedAt.length && now - startedAt[0] >= 60000) startedAt.shift();

    let waitMs = 0;
    if (now < pausedUntil) waitMs = pausedUntil - now;
    else if (startedAt.length >= MAX_PER_MINUTE) waitMs = Math.max(1, 60000 - (now - startedAt[0]));
    if (waitMs > 0) {
      pumpTimer = setTimeout(() => {
        pumpTimer = null;
        pump();
      }, waitMs);
      return;
    }

    while (inFlight.size < MAX_CONCURRENT && queue.length && startedAt.length < MAX_PER_MINUTE) {
      const uri = queue.shift();
      if (!wanted.has(uri) || cache.get(uri) !== undefined) continue;
      inFlight.add(uri);
      stats.fetched++;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight.size);
      startedAt.push(Date.now());
      fetchCredits(uri)
        .then((producers) => {
          if (failures) {
            // A success after failures means the network is back: retry tracks that ran out of attempts.
            givenUp.clear();
            attempts.clear();
          }
          failures = 0;
          cache.set(uri, producers);
          scheduleCacheSave();
        })
        .catch((e) => {
          // Back off the whole queue, not just this track, and don't cache the failure.
          failures++;
          stats.failed++;
          pausedUntil = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
          const n = (attempts.get(uri) || 0) + 1;
          attempts.set(uri, n);
          if (n >= MAX_ATTEMPTS) givenUp.add(uri);
          else if (wanted.has(uri)) queue.push(uri);
          console.warn(LOG_PREFIX, `Credits fetch failed (${failures} in a row), pausing.`, e);
        })
        .finally(() => {
          inFlight.delete(uri);
          scheduleInject();
          pump();
        });
    }
  }

  //#endregion

  //#region Page track index

  let currentSurface = null;
  /** @type {Map<string, string>} */
  let trackIndex = new Map();
  let indexLoadToken = 0;

  function detectSurface() {
    const path = Spicetify.Platform.History.location.pathname || "";
    const m = path.match(/^\/(album|playlist)\/([A-Za-z0-9]+)/);
    if (!m) return null;
    const kind = m[1];
    if ((kind === "album" && !config.albums) || (kind === "playlist" && !config.playlists)) return null;
    return { kind, uri: `spotify:${kind}:${m[2]}` };
  }

  async function loadAlbumTracks(uri) {
    const tracks = [];
    for (let offset = 0; ; offset += 300) {
      const res = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.getAlbum, {
        uri,
        locale: Spicetify.Locale.getLocale(),
        limit: 300,
        offset,
      });
      const page = res && res.data && res.data.albumUnion && res.data.albumUnion.tracksV2;
      const items = (page && page.items) || [];
      for (const { track } of items) {
        if (track) tracks.push({ name: track.name, durationMs: track.duration && track.duration.totalMilliseconds, uri: track.uri });
      }
      if (!items.length || offset + items.length >= ((page && page.totalCount) || 0)) break;
    }
    return tracks;
  }

  async function loadPlaylistTracks(uri) {
    const res = await Spicetify.Platform.PlaylistAPI.getContents(uri);
    return ((res && res.items) || []).map((it) => ({
      name: it.name,
      durationMs: it.duration && it.duration.milliseconds,
      uri: it.uri,
    }));
  }

  const INDEX_REFRESH_MS = 15000;
  const INDEX_RETRY_MS = [2000, 10000, 30000];
  let lastIndexRefresh = 0;
  let indexRetryTimer = null;
  let indexFailed = false;
  /** Row keys seen without a match. A key still missing after a reload is "unmatched" for this page. */
  let missingKeys = new Set();
  let unmatchedKeys = new Set();

  /**
   * A row with no match usually means tracks were added to the playlist after it loaded.
   * Each new missing key earns at most one reload; it is never retried on this page after that.
   */
  function noteMissingKey(key) {
    if (unmatchedKeys.has(key) || missingKeys.has(key)) return;
    missingKeys.add(key);
    if (!currentSurface || Date.now() - lastIndexRefresh < INDEX_REFRESH_MS) return;
    lastIndexRefresh = Date.now();
    loadIndex(currentSurface);
  }

  async function loadIndex(surface, attempt = 0) {
    const token = ++indexLoadToken;
    const asked = new Set(missingKeys);
    try {
      const tracks = surface.kind === "album" ? await loadAlbumTracks(surface.uri) : await loadPlaylistTracks(surface.uri);
      if (token !== indexLoadToken || destroyed) return;
      trackIndex = buildTrackIndex(tracks);
      for (const key of asked) if (!trackIndex.has(key)) unmatchedKeys.add(key);
      missingKeys = new Set([...missingKeys].filter((k) => !asked.has(k)));
      scheduleInject();
    } catch (e) {
      if (token !== indexLoadToken || destroyed) return;
      console.warn(LOG_PREFIX, "Couldn't load this page's tracks.", e);
      if (attempt < INDEX_RETRY_MS.length) {
        indexRetryTimer = setTimeout(() => {
          if (currentSurface && currentSurface.uri === surface.uri) loadIndex(surface, attempt + 1);
        }, INDEX_RETRY_MS[attempt]);
      } else {
        indexFailed = true;
        scheduleInject();
      }
    }
  }

  async function onNavigate() {
    const surface = detectSurface();
    const same = surface && currentSurface && surface.uri === currentSurface.uri;
    currentSurface = surface;
    if (same) return scheduleInject();

    trackIndex = new Map();
    missingKeys = new Set();
    unmatchedKeys = new Set();
    indexFailed = false;
    clearTimeout(indexRetryTimer);
    queue = [];
    closePopover();
    scheduleInject();
    if (!surface) return;
    lastIndexRefresh = Date.now();
    await loadIndex(surface);
  }

  //#endregion

  //#region Row reading

  /**
   * Text of an element's own text nodes only. Our inline span lives inside the
   * subtitle, never the title, but reading direct text keeps any injected node
   * from ever feeding back into the lookup (see local-files-plus's
   * "self-poisoning" loop).
   */
  function directTextContent(el) {
    let text = "";
    for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    return text;
  }

  function rowCells(row) {
    return [...row.querySelectorAll(SEL_CELL)].filter((c) => !c.classList.contains("pr-cell"));
  }

  function readRow(row) {
    const cells = rowCells(row);
    const titleCell = cells.find((c) => c.getAttribute("aria-colindex") === "2");
    const lastCell = cells[cells.length - 1];
    if (!titleCell || !lastCell) return null;

    const titleEl = [...titleCell.querySelectorAll("div")].find((d) => directTextContent(d).trim());
    const durationEl = [...lastCell.querySelectorAll("div, span")].find((d) => DURATION_RE.test(directTextContent(d).trim()));
    if (!titleEl || !durationEl) return null;

    const artistLinks = [...titleCell.querySelectorAll('a[href^="/artist/"]')];
    return {
      key: rowKey(directTextContent(titleEl), directTextContent(durationEl)),
      titleCell,
      subtitleEl: artistLinks.length ? artistLinks[0].parentElement : null,
      artistNames: new Set(artistLinks.map((a) => a.textContent.trim().toLowerCase())),
      lastCell,
    };
  }

  //#endregion

  //#region Rendering

  function stopRowHandlers(el) {
    for (const type of ["click", "dblclick", "mousedown", "pointerdown"]) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
    // Enter/Space would otherwise reach the row's key handler (play/select); the element's own
    // default action (click) still runs.
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") e.stopPropagation();
    });
    el.setAttribute("draggable", "false");
    el.addEventListener("dragstart", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function nameNode(p) {
    if (!p.uri) {
      const span = document.createElement("span");
      span.className = "pr-name";
      span.textContent = p.name;
      return span;
    }
    const a = document.createElement("a");
    a.className = "pr-name pr-link";
    a.textContent = p.name;
    a.href = `/artist/${p.uri.split(":")[2]}`;
    stopRowHandlers(a);
    a.addEventListener("click", (e) => {
      e.preventDefault();
      closePopover();
      Spicetify.Platform.History.push(`/artist/${p.uri.split(":")[2]}`);
    });
    return a;
  }

  const STATE_TEXT = { loading: "…", none: "—", error: "?" };
  const STATE_TITLE = {
    loading: "Loading credits…",
    none: "Spotify lists no producer for this track",
    error: "Couldn't load credits for this track",
  };

  /**
   * Fills a cell (column or inline span) for one track.
   * @param {HTMLElement} el
   * @param {"loading"|"none"|"error"|"done"} state
   * @param {Producer[]} producers
   */
  function fillProducers(el, state, producers) {
    el.textContent = "";
    el.removeAttribute("title");
    if (state !== "done") {
      el.classList.add("pr-muted");
      el.textContent = STATE_TEXT[state];
      el.title = STATE_TITLE[state];
      return;
    }
    el.classList.remove("pr-muted");
    const { shown, hiddenCount } = splitForDisplay(producers);
    const names = document.createElement("span");
    names.className = "pr-names";
    names.title = producers.map((p) => p.name).join(", ");
    shown.forEach((p, i) => {
      if (i) names.appendChild(document.createTextNode(", "));
      names.appendChild(nameNode(p));
    });
    el.appendChild(names);
    if (hiddenCount) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "pr-more";
      chip.textContent = `+${hiddenCount}`;
      chip.setAttribute("aria-label", `Show all ${producers.length} producers`);
      chip.setAttribute("aria-haspopup", "dialog");
      stopRowHandlers(chip);
      bindPopover(chip, producers);
      el.appendChild(chip);
    }
  }

  /** @returns {{ state: "loading"|"none"|"error"|"done", producers: Producer[] }} */
  function rowState(key, uri) {
    if (!trackIndex.size) return { state: indexFailed ? "error" : "loading", producers: [] };
    if (!uri) return { state: unmatchedKeys.has(key) ? "error" : "loading", producers: [] };
    return stateFor(uri);
  }

  function stateFor(uri) {
    if (!uri.startsWith("spotify:track:")) return { state: "none", producers: [] };
    if (givenUp.has(uri)) return { state: "error", producers: [] };
    const cached = cache.get(uri);
    if (cached === undefined) return { state: "loading", producers: [] };
    return cached.length ? { state: "done", producers: cached } : { state: "none", producers: [] };
  }

  function renderRow(row, mode) {
    const info = readRow(row);
    if (!info) return;
    const uri = trackIndex.get(info.key) || null;
    if (!uri && trackIndex.size) noteMissingKey(info.key);
    if (uri && uri.startsWith("spotify:track:")) {
      wanted.add(uri);
      enqueue(uri);
    }
    const { state, producers } = rowState(info.key, uri);
    const stamp = `${mode}|${uri}|${state}|${producers.length}`;

    const existingCell = row.querySelector(":scope .pr-cell");
    const existingInline = info.titleCell.querySelector(".pr-inline");
    const target = mode === "column" ? existingCell : existingInline;
    if (target && target.dataset.prStamp === stamp) return;

    if (mode === "column") {
      if (existingInline) existingInline.remove();
      let cell = existingCell;
      if (!cell) {
        cell = document.createElement("div");
        cell.className = "pr-cell";
        cell.setAttribute("role", "gridcell");
        info.lastCell.parentElement.insertBefore(cell, info.lastCell);
      }
      cell.dataset.prStamp = stamp;
      fillProducers(cell, state, producers);
    } else {
      if (existingCell) existingCell.remove();
      if (!info.subtitleEl) return;
      let span = existingInline;
      if (!span) {
        span = document.createElement("span");
        span.className = "pr-inline";
      }
      // Re-append every time: a recycled row can gain artist links that React appends after our span.
      info.subtitleEl.appendChild(span);
      span.dataset.prStamp = stamp;
      span.textContent = "";
      // Space under the title is scarce: skip producers already named as the track's artists.
      const others = producers.filter((p) => !info.artistNames.has(p.name.toLowerCase()));
      if (state === "done" && others.length) {
        const sep = document.createElement("span");
        sep.className = "pr-inline-sep";
        sep.textContent = " · Prod. ";
        const body = document.createElement("span");
        body.className = "pr-inline-body";
        fillProducers(body, state, others);
        span.append(sep, body);
      }
    }
  }

  function renderHeader(grid, mode) {
    const header = grid.querySelector('[role="row"][aria-rowindex="1"]');
    if (!header) return;
    const existing = header.querySelector(".pr-header");
    if (mode !== "column") {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const cells = [...header.querySelectorAll(SEL_HEADER_CELL)];
    const last = cells[cells.length - 1];
    if (!last) return;
    const cell = document.createElement("div");
    cell.className = "pr-header";
    cell.setAttribute("role", "columnheader");
    cell.textContent = "Producers";
    last.parentElement.insertBefore(cell, last);
  }

  function updateGridStyle(grid, mode) {
    let el = document.getElementById(GRID_STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = GRID_STYLE_ID;
      document.head.appendChild(el);
    }
    // Spotify writes its template inline on the grid; an !important stylesheet rule wins
    // over it without touching React-owned attributes.
    const template = mode === "column" ? withProducersColumn(grid.style.getPropertyValue("--grid-template-columns")) : null;
    grid.classList.toggle("pr-active", !!template);
    const css = template ? `${SEL_GRID}.pr-active { --grid-template-columns: ${template} !important; }` : "";
    if (el.textContent !== css) el.textContent = css;
  }

  function clearAll() {
    document.querySelectorAll(".pr-cell, .pr-header, .pr-inline").forEach((el) => el.remove());
    document.querySelectorAll(".pr-active").forEach((el) => el.classList.remove("pr-active"));
    const el = document.getElementById(GRID_STYLE_ID);
    if (el) el.textContent = "";
  }

  let observedGrid = null;
  // Resizing a column rewrites only the grid's inline --grid-template-columns, which the subtree
  // observer doesn't watch, so our !important copy would go stale. We never write grid.style.
  const gridStyleObserver = new MutationObserver(scheduleInject);

  function watchGridStyle(grid) {
    if (grid === observedGrid) return;
    gridStyleObserver.disconnect();
    observedGrid = grid;
    if (grid) gridStyleObserver.observe(grid, { attributes: true, attributeFilter: ["style"] });
  }

  function injectAll() {
    const mainView = document.querySelector(SEL_MAIN_VIEW);
    const grid = currentSurface && mainView && mainView.querySelector(SEL_GRID);
    watchGridStyle(grid || null);
    if (!grid) {
      wanted = new Set();
      clearAll();
      return;
    }
    // Width, not aria-colcount: colcount also drops when the user hides Spotify's own columns.
    const mode = grid.clientWidth >= COLUMN_MIN_GRID_WIDTH ? "column" : "inline";
    updateGridStyle(grid, mode);
    renderHeader(grid, mode);

    wanted = new Set();
    for (const row of grid.querySelectorAll(SEL_ROW)) {
      if (row.getAttribute("aria-rowindex") === "1") continue;
      renderRow(row, mode);
    }
  }

  let injectTimer = null;
  function scheduleInject() {
    if (injectTimer || destroyed) return;
    injectTimer = setTimeout(() => {
      injectTimer = null;
      try {
        injectAll();
      } catch (e) {
        console.error(LOG_PREFIX, "Render failed.", e);
      }
    }, 100);
  }

  //#endregion

  //#region Popover

  let popoverEl = null;
  let popoverAnchor = null;
  let openTimer = null;
  let closeTimer = null;

  function ensurePopover() {
    if (popoverEl) return popoverEl;
    popoverEl = document.createElement("div");
    popoverEl.className = "pr-popover";
    popoverEl.setAttribute("role", "dialog");
    popoverEl.setAttribute("aria-label", "Producers");
    popoverEl.hidden = true;
    popoverEl.addEventListener("mouseenter", () => clearTimeout(closeTimer));
    popoverEl.addEventListener("mouseleave", scheduleClose);
    popoverEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const anchor = popoverAnchor;
        closePopover();
        if (anchor) anchor.focus();
      }
    });
    document.body.appendChild(popoverEl);
    return popoverEl;
  }

  function openPopover(anchor, producers) {
    const pop = ensurePopover();
    clearTimeout(closeTimer);
    popoverAnchor = anchor;
    pop.textContent = "";
    for (const group of groupByRole(producers)) {
      const h = document.createElement("div");
      h.className = "pr-popover-role";
      h.textContent = group.people.length > 1 ? `${group.role}s` : group.role;
      pop.appendChild(h);
      for (const p of group.people) {
        const line = document.createElement("div");
        line.className = "pr-popover-person";
        line.appendChild(nameNode(p));
        pop.appendChild(line);
      }
    }
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.right - pr.width), window.innerWidth - pr.width - 8);
    const below = r.bottom + 6 + pr.height <= window.innerHeight - 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - pr.height - 6)}px`;
    anchor.setAttribute("aria-expanded", "true");
  }

  function closePopover() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (popoverAnchor) popoverAnchor.setAttribute("aria-expanded", "false");
    popoverAnchor = null;
    if (popoverEl) popoverEl.hidden = true;
  }

  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closePopover, 200);
  }

  function bindPopover(chip, producers) {
    chip.setAttribute("aria-expanded", "false");
    chip.addEventListener("mouseenter", () => {
      clearTimeout(closeTimer);
      clearTimeout(openTimer);
      openTimer = setTimeout(() => openPopover(chip, producers), 150);
    });
    chip.addEventListener("mouseleave", () => {
      clearTimeout(openTimer);
      scheduleClose();
    });
    chip.addEventListener("click", () => {
      if (popoverAnchor === chip) closePopover();
      else openPopover(chip, producers);
    });
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePopover();
    });
  }

  //#endregion

  //#region Styles

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = `
      /* Placed by line name, not DOM order: React inserts newly enabled native columns next to its own cells, after ours. */
      .pr-cell, .pr-header { grid-column: producers; display: flex; align-items: center; min-width: 0; overflow: hidden; white-space: nowrap; font-size: 0.875rem; }
      .pr-cell { color: var(--text-subdued, #b3b3b3); gap: 6px; }
      .pr-header { color: var(--text-subdued, #b3b3b3); }
      .pr-names { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .pr-muted { color: var(--text-subdued, #b3b3b3); opacity: 0.6; }
      .pr-cell a.pr-link, .pr-inline a.pr-link, .pr-popover a.pr-link { color: inherit; text-decoration: none; }
      .pr-cell a.pr-link:hover, .pr-inline a.pr-link:hover, .pr-popover a.pr-link:hover { color: var(--text-base, #fff); text-decoration: underline; }
      [role="row"]:hover .pr-cell { color: var(--text-base, #fff); }
      .pr-link:focus-visible, .pr-more:focus-visible { outline: 2px solid var(--text-base, #fff); outline-offset: 2px; border-radius: 2px; }
      .pr-more { flex: none; border: 0; border-radius: 9999px; padding: 1px 7px; font-size: 0.75rem; font-weight: 700; cursor: pointer;
        color: var(--text-base, #fff); background: rgba(255, 255, 255, 0.1); }
      .pr-more:hover, .pr-more[aria-expanded="true"] { background: rgba(255, 255, 255, 0.2); }
      /* Inline mode: Spotify's subtitle is a one-line ellipsis block, which would hide anything appended
         at its end. Flex it (via :has, so no React-owned attribute changes) and let each artist link
         ellipsize on its own while the producers keep their space. */
      [role="gridcell"] div:has(> .pr-inline:not(:empty)) { display: flex; align-items: baseline; min-width: 0; white-space: pre; }
      [role="gridcell"] div:has(> .pr-inline:not(:empty)) > a { flex: 0 1 auto; min-width: 3ch; overflow: hidden; text-overflow: ellipsis; }
      .pr-inline { display: inline-flex; align-items: baseline; flex: 0 1 auto; min-width: 0; white-space: nowrap; }
      .pr-inline:empty { display: none; }
      .pr-inline-sep { flex: none; white-space: pre; }
      .pr-inline-body { display: inline-flex; align-items: baseline; min-width: 0; gap: 4px; }
      .pr-inline-body .pr-names { overflow: hidden; text-overflow: ellipsis; }
      .pr-popover { position: fixed; z-index: 9999; min-width: 180px; max-width: 320px; max-height: 60vh; overflow-y: auto;
        padding: 8px 0; border-radius: 6px; background: #282828; color: var(--text-base, #fff);
        box-shadow: 0 16px 24px rgba(0, 0, 0, 0.3), 0 6px 8px rgba(0, 0, 0, 0.2); font-size: 0.875rem; }
      .pr-popover[hidden] { display: none; }
      .pr-popover-role { padding: 8px 14px 4px; font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
        color: var(--text-subdued, #b3b3b3); }
      .pr-popover-person { padding: 5px 14px; }
      .pr-popover-person .pr-name:not(.pr-link) { color: var(--text-subdued, #b3b3b3); }
    `;
    document.head.appendChild(el);
  }

  //#endregion

  //#region Spotify's "Columns" menu

  /**
   * Adds a "Producers" checkbox to Spotify's own Columns menu (List button -> Columns),
   * cloned from one of its items so it looks native. The clone has no React props, so
   * Spotify's delegated handlers ignore it and our listener owns the click.
   * @param {Element} added
   */
  function augmentColumnsMenu(added) {
    const surface = detectSurfaceKind();
    if (!surface) return;
    const menus = added.matches('[role="menu"]') ? [added] : [...added.querySelectorAll('[role="menu"]')];
    for (const menu of menus) {
      const items = menu.querySelectorAll('button[role="menuitemcheckbox"][data-column]');
      if (!items.length || menu.querySelector('[data-column="PR_PRODUCERS"]')) continue;
      const templateLi = items[items.length - 1].closest("li");
      if (!templateLi) continue;
      const li = /** @type {HTMLElement} */ (templateLi.cloneNode(true));
      const btn = li.querySelector("button");
      const input = li.querySelector('input[type="checkbox"]');
      const label = li.querySelector("label");
      const text = btn.querySelector("span");
      btn.dataset.column = "PR_PRODUCERS";
      btn.setAttribute("aria-label", "Producers");
      if (text) text.textContent = "Producers";
      if (input) {
        input.id = "column-visibility-PR_PRODUCERS";
        input.setAttribute("aria-label", "Producers");
      }
      if (label) label.htmlFor = "column-visibility-PR_PRODUCERS";
      const sync = () => {
        const on = !!config[surface];
        btn.setAttribute("aria-checked", String(on));
        if (input) input.checked = on;
      };
      sync();
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        config[surface] = !config[surface];
        saveConfig();
        sync();
        currentSurface = null;
        onNavigate();
      });
      templateLi.after(li);
    }
  }

  /** "albums" | "playlists" for the page in view, ignoring whether it's enabled. */
  function detectSurfaceKind() {
    const path = Spicetify.Platform.History.location.pathname || "";
    if (path.startsWith("/album/")) return "albums";
    if (path.startsWith("/playlist/")) return "playlists";
    return null;
  }

  //#endregion

  //#region Settings

  function openSettings() {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:12px;";
    const toggles = [
      ["albums", "Show on album pages"],
      ["playlists", "Show on playlist pages"],
    ];
    for (const [key, label] of toggles) {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer;";
      const text = document.createElement("span");
      text.textContent = label;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!config[key];
      box.addEventListener("change", () => {
        config[key] = box.checked;
        saveConfig();
        currentSurface = null;
        onNavigate();
      });
      row.append(text, box);
      wrap.appendChild(row);
    }
    const footer = document.createElement("div");
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:12px;margin-top:8px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.1);font-size:0.75rem;color:var(--text-subdued,#b3b3b3);";
    const repo = document.createElement("a");
    repo.href = `https://github.com/${PR_GITHUB_REPO}`;
    repo.textContent = "GitHub";
    repo.style.color = "inherit";
    const version = document.createElement("span");
    version.textContent = `v${PR_VERSION}`;
    footer.append(repo, version);
    wrap.appendChild(footer);
    Spicetify.PopupModal.display({ title: "Producers", content: wrap });
  }

  //#endregion

  //#region Init

  /** @type {(() => void)[]} */
  const teardown = [];
  let destroyed = false;

  function setupObservers() {
    const main = document.querySelector(SEL_MAIN_VIEW);
    if (main) {
      // childList for virtualized row recycling; aria-colcount (read-only to us) so the header
      // follows Spotify's own column toggles. Never observe other attributes: React rewrites them.
      const observer = new MutationObserver(scheduleInject);
      observer.observe(main, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-colcount"],
      });
      main.addEventListener("scroll", closePopover, { capture: true, passive: true });
      // Sidebars open and close without a window resize, so watch the view itself.
      const resizeObserver = new ResizeObserver(scheduleInject);
      resizeObserver.observe(main);
      teardown.push(
        () => observer.disconnect(),
        () => resizeObserver.disconnect(),
        () => main.removeEventListener("scroll", closePopover, { capture: true }),
      );
    }
    // Menus are portalled to <body>; only added nodes are inspected.
    const menuObserver = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) augmentColumnsMenu(n);
    });
    menuObserver.observe(document.body, { childList: true, subtree: true });
    teardown.push(() => menuObserver.disconnect());
    const unlisten = Spicetify.Platform.History.listen(onNavigate);
    if (typeof unlisten === "function") teardown.push(unlisten);
  }

  /** Removes everything this instance added, so a re-injected copy (live testing) starts clean. */
  function destroy() {
    destroyed = true;
    teardown.splice(0).forEach((fn) => fn());
    gridStyleObserver.disconnect();
    clearTimeout(injectTimer);
    clearTimeout(pumpTimer);
    clearTimeout(indexRetryTimer);
    flushCacheSave();
    queue = [];
    closePopover();
    clearAll();
    if (popoverEl) popoverEl.remove();
    const styles = document.getElementById(STYLE_ID);
    if (styles) styles.remove();
  }

  async function main() {
    while (
      !Spicetify.Platform || !Spicetify.Platform.History || !Spicetify.Platform.PlaylistAPI ||
      !Spicetify.GraphQL || !Spicetify.GraphQL.Definitions || !Spicetify.LocalStorage ||
      !Spicetify.Menu || !Spicetify.PopupModal || !document.querySelector(SEL_MAIN_VIEW)
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (window.__producersExtension) window.__producersExtension.destroy();
    window.__producersExtension = { destroy, version: PR_VERSION, stats, cache };

    loadConfig();
    loadCache();
    injectStyles();
    const menuItem = new Spicetify.Menu.Item("Producers", false, openSettings);
    menuItem.register();
    teardown.push(() => menuItem.deregister());
    setupObservers();
    onNavigate();
    console.log(LOG_PREFIX, `v${PR_VERSION} initialized, ${cache.size} cached tracks.`);
  }

  main().catch((e) => console.error(LOG_PREFIX, "Fatal init error.", e));

  //#endregion
})();
