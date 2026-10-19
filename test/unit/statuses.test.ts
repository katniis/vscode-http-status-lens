import assert from "node:assert/strict";
import { STATUS_CODES } from "node:http";
import { describe, it } from "mocha";

type StatusInfo = {
  code: number;
  phrase: string;
  category: string;
  description: string;
};

function registry(): {
  getStatus(code: number): StatusInfo | undefined;
  getAllStatuses(): readonly StatusInfo[];
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep the missing implementation as the deliberate RED failure.
  return require("../../src/statuses") as ReturnType<typeof registry>;
}

describe("status registry", () => {
  it("returnsKnownStatusMetadata", () => {
    const { getStatus } = registry();

    assert.deepEqual(getStatus(200), {
      code: 200,
      phrase: "OK",
      category: "Success",
      description: "The request succeeded.",
    });
    assert.deepEqual(getStatus(404), {
      code: 404,
      phrase: "Not Found",
      category: "Client error",
      description: "The server cannot find the requested resource.",
    });
  });

  it("returnsUndefinedForUnknownStatus", () => {
    assert.equal(registry().getStatus(999), undefined);
  });

  it("sortsStatusesNumerically", () => {
    const codes = registry().getAllStatuses().map(({ code }) => code);
    assert.deepEqual(codes, [...codes].sort((left, right) => left - right));
  });

  it("coversNodeStatusCodes", () => {
    const codes = registry().getAllStatuses().map(({ code }) => code);
    const nodeCodes = Object.keys(STATUS_CODES).map(Number).sort((left, right) => left - right);
    assert.deepEqual(codes, nodeCodes);
    assert.ok(registry().getAllStatuses().every(({ description }) => description.length > 0));
  });
});
