import assert from "node:assert/strict";
import { describe, it } from "mocha";

type Candidate = { code: number; label: string; detail: string; insertText: string; suggested?: boolean };
type Suggestion = { code: number; detail: string };
type CompletionContext = { replyName: string; framework: "express" | "fastify" };
type Completions = {
  matchCompletionPrefix(linePrefix: string): { kind: "status" | "sendStatus"; query: string; start: number } | undefined;
  getCompletionCandidates(kind: "status" | "sendStatus", query: string, suggestion?: Suggestion, context?: CompletionContext): readonly Candidate[];
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

  it("usesFastifyReplyInsertionForStatusAndSendStatus", () => {
    const candidates = completions().getCompletionCandidates("status", "404", undefined, { replyName: "reply", framework: "fastify" });
    assert.equal(candidates[0]?.insertText, "reply.code(404)");
    const sendCandidates = completions().getCompletionCandidates("sendStatus", "404", undefined, { replyName: "reply", framework: "fastify" });
    assert.equal(sendCandidates[0]?.insertText, "reply.code(404).send()");
  });

  it("formatsCandidateDetailsWithoutCenterDots", () => {
    assert.equal(completions().getCompletionCandidates("status", "404")[0]?.detail, "Not Found (Client error)");
  });

  it("ranksTheContextSuggestionWithoutRemovingOtherCandidates", () => {
    const { getCompletionCandidates } = completions();
    for (const kind of ["status", "sendStatus"] as const) {
      const candidates = getCompletionCandidates(kind, "", { code: 404, detail: "Suggested from this branch: 404 Not Found" });
      assert.equal(candidates[0]?.code, 404);
      assert.equal(candidates.filter(({ code }) => code === 404).length, 1);
      assert.equal(candidates.some(({ code }) => code === 200), true);
      assert.equal(candidates[0]?.suggested, true);
      assert.match(candidates[0]?.detail ?? "", /Suggested from this branch/);
    }
  });

  it("rejectsPrefixEmbeddedInIdentifier", () => {
    const { matchCompletionPrefix } = completions();
    assert.equal(matchCompletionPrefix("const myrs404"), undefined);
    assert.equal(matchCompletionPrefix("const rs404value"), undefined);
    assert.equal(matchCompletionPrefix("const rs1234"), undefined);
  });
});
