# FastAPI support

HTTP Status Lens statically analyzes file-backed Python FastAPI code. It does not run Python, import application modules, or make requests.

## Recognized patterns

- Top-level `FastAPI()` applications and `APIRouter()` instances imported from FastAPI, including imported aliases.
- One-line decorators for `get`, `post`, `put`, `patch`, `delete`, `options`, `head`, and `trace`, with literal paths or a `<dynamic path>` label.
- Static `APIRouter(prefix=...)` and local relative `include_router()` calls. Router imports stay inside the workspace, stop at cycles, visit at most 64 modules per document, and stop after 64 nesting levels.
- Top-level route endpoint functions. Explicit statuses include an imported FastAPI or Starlette `Response` parameter's `status_code` assignment, imported `HTTPException(status_code=...)`, and a route decorator's `status_code=...`. A returned value with no explicit status is shown as implicit 200.
- Explicit status literals receive the same decorations and hover metadata used by the JavaScript and TypeScript analyzers.

## Completions

In a route endpoint with a `Response` annotation imported from FastAPI or Starlette, `rs` and `rss` offer the full shared status registry and use the actual parameter name. In a statement position the insertion sets `response.status_code`; after `return rs` or `return rss`, it inserts `setattr(response, "status_code", code) or response`, which sets the status and returns the injected response. A clear, unique branch cue can rank a status first while leaving every other candidate available.

## Limits

Analysis is conservative. It ignores package imports, absolute imports, unresolved router registrations, dynamic route paths beyond their placeholder, nested endpoint functions, route factories, multiline decorators and definitions, and status changes hidden in helper functions. Status ranking stays inside the current handler and only uses clear, unique cues. A route endpoint needs an injected, imported FastAPI or Starlette `Response` annotation for parameter-aware completion.
