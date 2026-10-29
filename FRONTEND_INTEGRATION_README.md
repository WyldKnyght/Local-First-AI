# Local-first AI: first assistant-ui frontend integration

## Scope

Complete replacement files, not patches. Targets the reported assistant-ui
0.15.26 installation and the existing Python API. At the time this archive was
prepared, build compatibility had not been verified on the desktop and it had
not been browser-tested; see the dated validation sections below for later
results.

Includes assistant-ui chat primitives, the external-store adapter, a
Perplexity-style layout, blank conversation startup, New conversation, streamed
chat responses, and explicit memory controls. Saved conversations are retained,
but conversation browsing/reopening, search, attachments, voice, model selection,
authentication, and LAN deployment remain out of scope.

## Apply

1. Stop the frontend development server if it is running.
2. Retain a copy of the existing frontend files if you want an easy rollback.
3. Extract the archive into P:\Repos-Github\Local-First-AI, preserving its
   frontend folder structure and replacing matching files.
4. Do not extract it into frontend itself; that would create frontend/frontend.
5. No Python files, SQLite databases, package.json, lockfiles, or .gitignore
   files are included or replaced.
6. App.css and old template assets may remain unused; deletion is unnecessary.

## Local startup — current working setup

Consult this section for the current local startup procedure.

Backend — separate terminal:

```powershell
Set-Location "P:\Repos-Github\Local-First-AI"
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Frontend — separate terminal:

```powershell
Set-Location "P:\Repos-Github\Local-First-AI\frontend"
npm run dev -- --host 127.0.0.1
```

- Browser: http://127.0.0.1:5173/
- Backend: http://127.0.0.1:8000
Ollama must be running. The backend-configured model is `mistral:7b-instruct`,
using the inference endpoint `http://127.0.0.1:11434/api/chat`.

The frontend startup command was supplied by the user. The backend startup
command and model configuration were identified in local code/documentation
inspection; they were not newly runtime-tested during that inspection.

If port 8000 is occupied, identify the existing server rather than starting a
second instance.

## Verify frontend

```powershell
Set-Location "P:\Repos-Github\Local-First-AI\frontend"
npm ls @assistant-ui/react --depth=0
npm run build
npm run lint
```

Only continue if the package is installed and build/lint pass.

## Browser test

Open http://127.0.0.1:5173/; each fresh page load starts a blank conversation.
To check a completed exchange in the current conversation, use its in-page
Refresh saved history action. A browser refresh starts a different blank
conversation, so it is no longer a visual persistence check for the previous
conversation.

New conversation also creates another database record without deleting the old
one. Saved conversations are retained, but conversation browsing/reopening is not
available through the UI yet. Durable memory remains available and no memory key
is selected automatically on startup.

Use 127.0.0.1:5173 consistently rather than alternating with localhost:5173.

The Vite proxy is development-only. A production build is not yet wired to
FastAPI; this archive does not complete production hosting.

This was the original streaming-integration recovery guidance. Explicit
request-scoped cancellation was added in the later cancellation increment below.
Browser refresh or disconnect still does not guarantee inference stops. Keep one
browser tab for the acceptance sequence.

## Failure/recovery validation — 2026-10-20

User-reported results: the baseline request returned `BASELINE OK`. After
quitting Ollama, the next request displayed:

> Ollama request failed. If the response was interrupted, refresh to check saved history before resending.

After restarting Ollama, a request returned `RECOVERY OK`. Under the
pre-streaming interface, the failed user message disappeared when the recovery
message was submitted, and the resulting conversation remained unchanged after
browser refresh. That historical result predates the streamed pending-message
recovery flow below. No frontend or backend restart was needed.

While a long response was being generated, Ollama was stopped. The application
displayed:

> Ollama request failed. If the response was interrupted, refresh to check saved history before resending.

After restarting Ollama, a request returned `INTERRUPTION RECOVERY OK`. The
error cleared, no partial answer appeared, and browser refresh left the recovered
chat unchanged. This test also predates the streaming interface.

Conclusion: both the unavailable-service and mid-generation interruption/recovery
paths passed against the earlier non-streaming interface. The streaming
implementation was not yet browser-tested at this 2026-10-20 checkpoint; later
streaming validation is recorded below. Explicit user cancellation is not
implemented; stopping Ollama is not an application cancellation feature.

## Code-review note

A read-only review of `main.py`, `memory.py`, and `storage.py` found no direct
model-output path to durable-memory writes or command execution. Memory writes
use the explicit application endpoint, and reviewed SQL data values use
parameterized queries. This was a targeted code inspection, not a comprehensive
security audit.

## Prototype checkpoint — 2026-10-20

This prototype increment covers the working localhost browser chat; explicit
memory save, retrieval, correction, and persistence across restart; passed
Ollama-unavailable and mid-generation interruption/recovery tests; and targeted
code review supporting application-controlled memory writes.

Limitations: explicit application cancellation is not implemented; LAN access
is not validated; and memory retrieval is not automatic. Streamed response
handling is implemented in the subsequent increment; live browser/Ollama
validation was outstanding at this 2026-10-20 checkpoint. This is a prototype
checkpoint, not completion of the full release plan.

## Streamed chat behavior

The compatible `POST /chat` endpoint remains non-streaming. The frontend uses
`POST /chat/stream`, which emits server-sent events:

- `text`: `{"request_id":"...","text":"..."}` for each Ollama content
  fragment.
- `completion`: includes the request ID, `status: "completed"`, and `saved: true`,
  plus conversation/model/memory metadata, only after the paired transaction
  commits.
- `cancelled`: includes the request ID and `saved: false`, after resources and
  the chat lock are released.
- `error`: includes the request ID, a distinct request/inference/transport/save
  status, and detail. A stream ending without a terminal event is not success.

The UI shows the pending user message and generated text separately from saved
history. Until completion confirmation, displayed text is provisional. On an
error or unconfirmed disconnect, the UI retains that provisional exchange,
blocks another send, and requires a successful saved-history refresh before a
retry. After confirmed completion it reloads canonical history; if that read
fails, the UI continues to label the exchange saved and offers the same refresh
step. Refreshing the browser remains available to inspect history after an
interruption. A browser disconnect releases application HTTP resources and the
chat lock when observed, but does not guarantee that Ollama cancels inference.

## Streaming validation — 2026-10-27

User-reported browser results, supported by the conversation and screenshots;
these were not tests newly performed while preparing this checkpoint:

- The React frontend was tested at http://127.0.0.1:5173/.
- Progressive response display passed.
- A completed exchange remained present after browser refresh.
- Explicit memory `stream_test_word` was saved and selected with value `maple`;
  a new conversation returned `maple`.
- The memory provenance-panel contents were not separately confirmed.
- Ollama was stopped while a counting response was visibly streaming. The UI
  displayed `Ollama request failed.` and clearly labelled the partial exchange
  as unconfirmed/provisional.
- After Ollama was restarted and saved history refreshed, the interrupted
  counting request and partial answer were absent.
- A subsequent recovery request succeeded and survived browser refresh.
- No remaining visible errors were reported.

Limitations and interpretation:

- The recovery answer included `STREAM RECOVERY OK` plus unsolicited memory
  commentary, so exact-output instruction adherence did not pass.
- Some longer answers ended mid-sentence. The retained `num_predict: 256` limit
  is a suspected explanation, not a verified diagnosis.
- Explicit application cancellation was not part of the October 27 validation;
  stopping Ollama was an interruption test, not a cancellation-feature test.
- This closes the tested streaming increment, not the full release plan.
- A Git checkpoint protects source code, not the local database or application
  data.

## Explicit cancellation behavior

Each streamed request uses a fresh UUID. `POST /chat/stream/{request_id}/cancel`
requests cancellation for that exact request, and
`GET /chat/stream/{request_id}/status` provides a read-only outcome lookup.
Cancellation and status responses are idempotent and terminal outcomes are
retained in memory for up to five minutes (bounded to 256 outcomes). A timeout
is pending/unknown, never proof of cancellation; the UI resolves status before
allowing another send. Unknown request IDs do not target another request.

Cancellation is serialized against the paired-message save. If cancellation
wins, no exchange is saved; after the backend acknowledges cancellation and
saved history has been refreshed, partial output remains visibly labelled
cancelled and unsaved. That local display is not canonical history or future
model context. If commit wins, the actual save result is reported instead.
Ordinary inference, transport, and save errors are separate outcomes.

Coordination is in-memory and single-process, matching the prototype's global
chat lock. Backend restart loses active request and terminal outcome state; a
status of unknown does not establish whether an exchange was saved. Closing the
Ollama connection is best-effort interruption and does not guarantee Ollama
stops computing. A browser/server disconnect is not the same as explicit user
cancellation. No schema or dependency changes are required for this prototype
protocol; multi-process deployment would require shared coordination and is
out of scope.

## Terminal SSE outcome fix - 2026-10-28

Live cancellation testing exposed a terminal-event payload defect: the request
registry stored and returned terminal outcomes enriched with `request_id`, but
the SSE generator discarded that canonical value and emitted its unenriched
local outcome. The frontend correctly requires `request_id`, so it rejected
terminal SSE events even though the status endpoint could resolve them.

The generator now emits the outcome returned by `finish()` after HTTPX cleanup
and release of the global chat lock. Completion, cancellation, and error SSE
payloads therefore match the repeatable request-ID status outcome. Frontend
validation remains strict. Regression tests parse actual emitted SSE frames
and compare their payloads with the originating request ID and status endpoint.

Local validation on 2026-10-28:

- `npm.cmd --prefix frontend run build` - passed; Vite reported a nonfatal
  bundle-size warning (579.48 kB minified JavaScript chunk).
- `npm.cmd --prefix frontend run lint` - passed.
- `.\.venv\Scripts\python.exe -m unittest discover -s tests -v` - all 14
  isolated backend tests passed.
- `.\.venv\Scripts\python.exe -m py_compile main.py tests\test_chat_streaming.py`
  - passed.
- `git diff --check` - passed.

These are local build, lint, isolated test, compilation, and whitespace checks.
They do not constitute a live-browser retest of the terminal SSE correction;
live retesting remains outstanding.

## Explicit cancellation validation - 2026-10-28

User-reported browser acceptance results, supported by the conversation; these
were not tests newly performed while documenting this checkpoint:

- The React frontend was tested at http://127.0.0.1:5173/.
- Stop during a streamed counting response was acknowledged, and the UI
  reported that the exchange was cancelled and not saved.
- A subsequent request succeeded without restarting services.
- The first cancellation attempt exposed the terminal SSE defect described
  above: the frontend rejected the event because `request_id` was absent.
  Clicking Check request status resolved that initial unknown outcome.
- The defect was corrected by emitting the canonical outcome returned by
  `finish()`.
- After correction, the Stop -> recovery -> refresh sequence passed:
  - Cancellation was acknowledged.
  - The follow-up completed without a status lookup or invalid-stream-event
    error.
  - The completed `CANCEL RECOVERY OK` exchange remained after browser refresh.
  - The user's final clarification was interpreted as confirming that the
    cancelled counting exchange did not remain after refresh.
- No direct database inspection was performed during browser validation.

Evidence boundaries and limitations:

- This was a browser acceptance sequence, not exhaustive cancellation testing.
  Commit-versus-cancel decision races, save outcomes, cancellation while waiting
  for the chat lock, duplicate requests/Stop, disconnect distinctions, and related
  edge cases have isolated test coverage only where present in the backend suite;
  they were not live-validated by this browser sequence. Lost acknowledgment was
  not tested live.
- Application cancellation closes the upstream HTTP connection but does not
  guarantee Ollama stopped computing.
- Coordination remains in-memory and single-process; a backend restart loses
  active request and retained terminal outcome state.
- Cancelled partial output is transient UI state, not canonical saved history or
  future model context.
- Blank-chat startup was outside the October 28 checkpoint scope.
- This checkpoint protects source code only; it is not a database backup or an
  off-PC copy.

Local checks run for this checkpoint documentation/commit:

- `npm.cmd --prefix frontend run build` - passed; Vite reported a nonfatal
  bundle-size warning for the 579.48 kB minified JavaScript chunk.
- `npm.cmd --prefix frontend run lint` - passed.
- `.\.venv\Scripts\python.exe -m unittest discover -s tests -v` - all 14
  isolated backend tests passed.
- `.\.venv\Scripts\python.exe -m py_compile main.py tests\test_chat_streaming.py`
  - passed.
- `git diff --check` - passed after the final documentation edit.

These local checks are not new live browser tests. The browser results above are
user-reported, and this section does not claim another live test pass.

## If anything fails

Paste the full build/lint error or browser error. Do not add cloud credentials,
provider SDKs, CORS wildcards, or expose either server to the LAN as a workaround.

## Blank-chat startup - 2026-10-29

Every fresh page load, including browser refresh, creates and opens one new blank
conversation. The startup request is created lazily from the React effect, not at
module import time. A module-scoped promise shares that one request between
StrictMode's repeated effect setup in the same page runtime; a genuine page reload
starts a new JavaScript runtime and therefore a new conversation. Initialization
failures are shown in the UI and are not silently retried by effect setup.

Existing saved conversations and durable memory are not deleted or changed.
Saved conversations cannot yet be browsed or reopened through the UI. No memory
key is selected on startup. The in-page Refresh saved history action still loads
the current conversation; it does not create a new one. Browser refresh creates a
new conversation, and refreshing while a request is active is not equivalent to
pressing Stop or receiving an acknowledged cancellation.


## Blank-chat startup validation - 2026-10-29

User-reported browser acceptance confirmed that a browser refresh opens a blank
conversation, no memory key is selected on startup, normal message completion
works, and New conversation works. The user also separately performed a local,
read-only SQLite inspection and confirmed the exact `BLANK STARTUP TEST OK`
test exchange remained stored: the user and assistant messages were under the
same conversation ID and the expected assistant response was present. No
conversation UUID or database contents were displayed or recorded here.

Blank startup changes which conversation opens; it does not delete saved history.
Conversation browsing/reopening remains unavailable through the UI. Browser
refresh is not an acknowledged cancellation. No automated frontend tests were
added; build/lint and the reported manual acceptance are the validation basis.

Local checks for this checkpoint:

- `npm.cmd --prefix frontend run build` - passed. Vite emitted a nonfatal
  warning for the 579.38 kB minified JavaScript chunk.
- `npm.cmd --prefix frontend run lint` - passed.
- `git diff --check` - passed.

No automated frontend tests were added. The checks above and the user-reported
manual browser acceptance are the validation basis; no live tests were repeated
for this checkpoint.
