const test = require("node:test");
const assert = require("node:assert/strict");
const { extractProducers } = require("../producers.js");
const fixtures = require("./fixtures/credits.json");

const contributors = (items) => ({ data: { trackUnion: { creditsTrait: { contributors: { items } } } } });
const person = (name, role, uri = null) => ({ name, role, roleGroup: { name: "Production & Engineering" }, uri, url: null });

test("picks the producer out of a real response, keeping the artist link", () => {
  // Fixture 0: Your Old Droog, "You Know How That Go" — J-Es is Composer, Producer and Beats.
  assert.deepEqual(extractProducers(fixtures[0]), [{ name: "J-Es", role: "Producer", uri: fixtures[0].data.trackUnion.creditsTrait.contributors.items.find((i) => i.role === "Producer").uri }]);
});

test("returns every real fixture's producers in Spotify's order", () => {
  assert.deepEqual(extractProducers(fixtures[2]).map((p) => p.name), ["Anais Marinho"]);
  assert.deepEqual(extractProducers(fixtures[3]).map((p) => p.name), ["Gianluca Buccellati"]);
});

test("counts Producer, Co-Producer and Studio Producer, ignoring case", () => {
  const res = contributors([
    person("A", "Producer"),
    person("B", "studio producer"),
    person("C", "Co-Producer"),
    person("D", "Executive Producer"),
    person("E", "Vocal Producer"),
    person("F", "Additional Producer"),
    person("G", "Mixing Engineer"),
  ]);
  assert.deepEqual(extractProducers(res).map((p) => `${p.name}:${p.role}`), ["A:Producer", "B:studio producer", "C:Co-Producer"]);
});

test("lists a person once even when they hold two producer roles", () => {
  const res = contributors([
    person("Mike Stock", "Producer", "spotify:artist:2JhG3QOWCDbDXNYhqFDSj1"),
    person("Mike Stock", "Studio Producer", "spotify:artist:2JhG3QOWCDbDXNYhqFDSj1"),
    person("Sam", "Studio Producer"),
    person("Sam", "Producer"),
  ]);
  assert.deepEqual(extractProducers(res).map((p) => `${p.name}:${p.role}`), ["Mike Stock:Producer", "Sam:Studio Producer"]);
});

test("normalises a missing artist link to null", () => {
  const res = contributors([{ name: "Nobody", role: "Producer", roleGroup: { name: "x" } }]);
  assert.deepEqual(extractProducers(res), [{ name: "Nobody", role: "Producer", uri: null }]);
});

test("returns [] for responses without credits instead of throwing", () => {
  for (const res of [undefined, null, {}, { data: null }, { data: { trackUnion: null } }, { data: { trackUnion: { creditsTrait: null } } }, contributors(null), contributors([])]) {
    assert.deepEqual(extractProducers(res), []);
  }
});

test("skips malformed contributors", () => {
  const res = contributors([null, { role: "Producer" }, { name: "No role" }, person("Kept", "Producer")]);
  assert.deepEqual(extractProducers(res).map((p) => p.name), ["Kept"]);
});
