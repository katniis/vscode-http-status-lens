import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { isPythonReturnExpression } from "../../src/python/parser.js";

describe("Python completion context", () => {
  it("recognizesOpenReturnAndYieldParenthesizedExpressions", () => {
    assert.equal(isPythonReturnExpression("def endpoint():\n    return (\n        rs"), true);
    assert.equal(isPythonReturnExpression("def endpoint():\n    yield (\n        rss"), true);
  });

  it("ignoresClosedOrQuotedReturnParentheses", () => {
    assert.equal(isPythonReturnExpression("def endpoint():\n    return (value)\n    rs"), false);
    assert.equal(isPythonReturnExpression("def endpoint():\n    text = 'return ('\n    rs"), false);
  });
});
