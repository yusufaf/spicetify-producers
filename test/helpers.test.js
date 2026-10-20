const test = require("node:test");
const assert = require("node:assert/strict");
const { groupByRole, splitForDisplay, formatDuration, rowKey, buildTrackIndex, withProducersColumn, createCache } = require("../producers.js");

const p = (name, role = "Producer", uri = null) => ({ name, role, uri });

test("formats durations the way Spotify's tracklist shows them", () => {
  assert.equal(formatDuration(246795), "4:06"); // "From Within" on Logic1000's Mother: seconds are floored
  assert.equal(formatDuration(464000), "7:44");
  assert.equal(formatDuration(59999), "0:59");
  assert.equal(formatDuration(3723000), "1:02:03");
});

test("matches rows by lowercased title and duration, first track winning on duplicates", () => {
  const index = buildTrackIndex([
    { name: "From Within", durationMs: 246795, uri: "spotify:track:a" },
    { name: "From Within", durationMs: 246795, uri: "spotify:track:b" },
    { name: "Promises (feat. Rochelle Jordan)", durationMs: 208000, uri: "spotify:track:c" },
    { name: "No duration", uri: "spotify:track:d" },
  ]);
  assert.equal(index.get(rowKey("From Within ", "4:06")), "spotify:track:a");
  assert.equal(index.get(rowKey("promises (feat. rochelle jordan)", "3:28")), "spotify:track:c");
  assert.equal(index.size, 2);
});

test("shows two names and counts the rest", () => {
  assert.deepEqual(splitForDisplay([p("A")]), { shown: [p("A")], hiddenCount: 0 });
  assert.deepEqual(splitForDisplay([p("A"), p("B"), p("C"), p("D")]), { shown: [p("A"), p("B")], hiddenCount: 2 });
});

test("groups the popover by role in a fixed order and drops empty groups", () => {
  const groups = groupByRole([p("S", "Studio Producer"), p("A"), p("B")]);
  assert.deepEqual(groups.map((g) => [g.role, g.people.map((x) => x.name)]), [["Producer", ["A", "B"]], ["Studio Producer", ["S"]]]);
});

test("inserts the producers column right before Spotify's duration column", () => {
  const spotify = "[index] var(--index-column-width, 16px) [first] minmax(var(--first-min-width), var(--first-max-width, 4fr)) [last] minmax(var(--last-min-width), var(--last-max-width, 1fr))";
  const out = withProducersColumn(spotify, "120px");
  assert.match(out, /\[first\] minmax\(.*\) \[producers\] 120px \[last\] minmax/);
  assert.equal(withProducersColumn(out, "120px"), out, "applying twice must not add a second column");
  assert.equal(withProducersColumn("[index] 16px [first] 1fr"), null);
  assert.equal(withProducersColumn(""), null);
});

test("cache expires entries after the TTL", () => {
  let now = 0;
  const cache = createCache({ ttlMs: 1000, now: () => now });
  cache.set("t1", [p("A")]);
  cache.set("t2", []);
  now = 999;
  assert.deepEqual(cache.get("t1"), [p("A")]);
  assert.deepEqual(cache.get("t2"), [], "an empty result is a real answer, not a miss");
  now = 1001;
  assert.equal(cache.get("t1"), undefined);
});

test("cache evicts the least recently used entry when full", () => {
  const cache = createCache({ maxEntries: 2 });
  cache.set("a", []);
  cache.set("b", []);
  cache.get("a");
  cache.set("c", []);
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual(cache.get("a"), []);
  assert.deepEqual(cache.get("c"), []);
});

test("cache survives a save/load round trip and drops stale or malformed rows", () => {
  let now = 5000;
  const a = createCache({ ttlMs: 10000, now: () => now });
  a.set("spotify:track:1", [p("Linked", "Producer", "spotify:artist:abc"), p("Plain", "Studio Producer")]);
  a.set("spotify:track:2", [], 0);
  const b = createCache({ ttlMs: 10000, now: () => now });
  now = 12000;
  b.load(a.serialize());
  assert.deepEqual(b.get("spotify:track:1"), [p("Linked", "Producer", "spotify:artist:abc"), p("Plain", "Studio Producer")]);
  assert.equal(b.get("spotify:track:2"), undefined);

  const c = createCache();
  c.load("not json");
  c.load('[["x"], 7, null]');
  assert.equal(c.size, 0);
});

test("cache load skips rows with malformed people instead of throwing", () => {
  const cache = createCache();
  const now = Date.now();
  cache.load(JSON.stringify([
    ["spotify:track:bad1", now, [null]],
    ["spotify:track:bad2", now, ["Name only"]],
    [42, now, []],
    ["spotify:track:good", now, [["A", "Producer", null]]],
  ]));
  assert.equal(cache.size, 1);
  assert.deepEqual(cache.get("spotify:track:good"), [p("A")]);
});
