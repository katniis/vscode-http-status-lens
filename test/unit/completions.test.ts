import assert from "node:assert/strict";
import { describe, it } from "mocha";

type Candidate = { code: number; label: string; detail: string; insertText: string };
type Completions = {
  matchCompletionPrefix(linePrefix: string): { kind: "status" | "sendStatus"; query: string; start: number } | undefined;
  getCompletionCandidates(kind: "status" | "sendStatus", query: string): readonly Candidate[];
};

function completions(): Completions {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep missing implementation as the deliberate RED failure.
  return require("../../src/completions") as Completions;
}

describe("completions", () => {
  it("matchesCompletionPrefixAtCursor", () => {
    const prefix = "const result = rs40";
    assert.deepEqual(completions().matchCompletionPrefix(prefix), { kind: "status", query: "40", start: prefix.indexOf("rs40") });
    assert.deepEqual(completions().matchCompletionPrefix("res.sendStatus(rss4"), { kind: "sendStatus", query: "4", start: 15 });
  });

  it("keepsRsAndRssDistinct", () => {
    assert.equal(completions().matchCompletionPrefix("rs")?.kind, "status");
    assert.equal(completions().matchCompletionPrefix("rss")?.kind, "sendStatus");
  });

  it("listsAllStatusesForBarePrefix", () => {
    const candidates = completions().getCompletionCandidates("status", "");
    assert.ok(candidates.length > 50);
    assert.deepEqual(candidates.map(({ code }) => code), [...candidates.map(({ code }) => code)].sort((left, right) => left - right));
  });

  it("filtersByTypedDigits", () => {
    assert.deepEqual(completions().getCompletionCandidates("status", "40").map(({ code }) => code), [400, 401, 402, 403, 404, 405, 406, 407, 408, 409]);
  });

  it("rejectsUnknownCompletedCode", () => {
    assert.deepEqual(completions().getCompletionCandidates("status", "999"), []);
  });

  it("usesExactReplacementRange", () => {
    const prefix = "const value = rss404";
    const match = completions().matchCompletionPrefix(prefix);
    assert.ok(match);
    assert.equal(prefix.slice(match.start), "rss404");
  });

  it("buildsExpectedInsertText", () => {
    const { getCompletionCandidates } = completions();
    assert.equal(getCompletionCandidates("status", "404")[0]?.insertText, "res.status(404)");
    assert.equal(getCompletionCandidates("sendStatus", "404")[0]?.insertText, "res.sendStatus(404)");
  });

  it("rejectsPrefixEmbeddedInIdentifier", () => {
    const { matchCompletionPrefix } = completions();
    assert.equal(matchCompletionPrefix("const myrs404"), undefined);
    assert.equal(matchCompletionPrefix("const rs404value"), undefined);
    assert.equal(matchCompletionPrefix("const rs1234"), undefined);
  });
});
