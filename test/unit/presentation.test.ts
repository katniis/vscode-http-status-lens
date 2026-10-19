import assert from "node:assert/strict";
import { describe, it } from "mocha";
import type { RouteAnalysis } from "../../src/model.js";

type Presentation = {
  formatRouteTitle(route: RouteAnalysis): string;
  formatStatusHover(code: number): string;
};

function presentation(): Presentation {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep missing implementation as the deliberate RED failure.
  return require("../../src/presentation") as Presentation;
}

function route(statuses: RouteAnalysis["statuses"], path = "/users"): RouteAnalysis {
  return { method: "GET", path, range: { start: 0, end: 1 }, statuses };
}

describe("presentation", () => {
  it("formatsSortedRouteSummary", () => {
    assert.equal(presentation().formatRouteTitle(route([
      { kind: "explicit", code: 404 },
      { kind: "explicit", code: 200 },
    ])), "GET /users → 200 OK | 404 Not Found");
  });

  it("marksImplicitStatus", () => {
    assert.equal(presentation().formatRouteTitle(route([{ kind: "implicit", code: 200 }])), "GET /users → 200 OK (implicit)");
  });

  it("formatsNoDirectStatus", () => {
    assert.equal(presentation().formatRouteTitle(route([])), "GET /users → No direct status detected");
  });

  it("formatsDynamicPathAndStatus", () => {
    assert.equal(presentation().formatRouteTitle(route([{ kind: "dynamic" }], "<dynamic path>")), "GET <dynamic path> → dynamic status");
  });

  it("formatsKnownHover", () => {
    assert.equal(presentation().formatStatusHover(404), "404 Not Found\n\nClient error\n\nThe server cannot find the requested resource.");
  });

  it("formatsUnknownHover", () => {
    assert.equal(presentation().formatStatusHover(999), "999 Unknown status\n\nStatus code not recognized by Node.js.");
  });
});
