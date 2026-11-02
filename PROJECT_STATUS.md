# Project status - 2026-10-29

## Purpose and current scope

Local-First-AI is a Windows-hosted, local-first AI partner. The intended longer-term goal is browser access from devices on the home network; that exposure has not been validated or enabled. The current application is a localhost prototype, not a completed release or the full original roadmap.

## Current implementation

- Backend: Python, FastAPI, HTTPX, and SQLite. Chat inference calls the local Ollama `/api/chat` endpoint at `http://127.0.0.1:11434/api/chat`.
- Frontend: React 19, TypeScript, Vite, and assistant-ui 0.15.26.
- Configured model: `mistral:7b-instruct`; Ollama request options set `num_ctx: 4096` and `num_predict: 256`.
- The current React/Vite interface runs at `http://127.0.0.1:5173/`. FastAPI on port 8000 serves the older non-streaming `index.html` interface at `/`; its `/chat` endpoint remains for compatibility.
- Completed capabilities: localhost React chat, progressive streamed responses, paired user/assistant persistence in one transaction, explicit memory save/selection/retrieval, request-scoped acknowledged cancellation and status recovery, and blank-chat startup on each fresh page load.
- Blank startup selects no memory and does not delete conversation history. Browsing or reopening saved conversations is not implemented in the UI.

## Validation and evidence

**User-reported browser acceptance (not newly performed for this handoff):** the October 27 streaming sequence reported progressive display, persistence of completed exchanges, explicit-memory retrieval, and interruption recovery. The October 28 sequence reported acknowledged Stop, an unsaved cancelled exchange, successful follow-up, and refresh persistence after the terminal-SSE fix. The October 29 blank-startup sequence reported a blank conversation after refresh, no selected memory, successful normal chat and New conversation, and retained saved history.

**Separate read-only retention verification:** the user inspected SQLite read-only and confirmed that the exact blank-startup test exchange's user and assistant messages remained together under one conversation ID and the expected response was present. No UUID or conversation contents are included in this handoff.

**Recorded local automated checks:** on October 28, frontend build/lint, 14 isolated backend unittests, Python compilation, and `git diff --check` passed; the build had a nonfatal 579.48 kB minified-chunk warning. On October 29, frontend build/lint and `git diff --check` passed; the build had a nonfatal 579.38 kB minified-chunk warning. These are recorded historical results, not checks rerun for this handoff. No automated frontend tests were added. See [the dated integration and validation guide](./FRONTEND_INTEGRATION_README.md) for evidence boundaries and details.

## Source checkpoints

- Prototype, October 20: `9ff2189c87fd382bc59000d8f8e5df1d0c0df67d`, tag `prototype-localhost-2026-10-20`.
- Streaming, October 27: `49a86054429042abc15acb83e7bbf5830b39a6cb`, tag `streaming-localhost-2026-10-27`.
- Explicit cancellation, October 28: `1a136292cf539240c06609079a61ccfb8125bf0d`, tag `cancellation-localhost-2026-10-28`.
- Latest application checkpoint, blank-chat startup, October 29: `a16cd5d216964a8a425ba180b6eb847fa8f55ccc`, tag `blank-chat-startup-2026-10-29`.

These are source-code checkpoints, not database backups. The October 10 plan is a roadmap/proposal, not evidence that its proposed stages or features have been implemented. Projects and tasks are intended future organization, not implemented or designed. No next feature has been adopted.

## Limitations and recovery

- `num_predict: 256` bounds output; some longer answers ended mid-sentence. This is a plausible contributor, not a verified diagnosis. The October 27 recovery answer also included unsolicited memory commentary, so exact instruction adherence did not pass.
- Cancellation/status coordination is in-memory and single-process; a backend restart loses active and retained terminal request state. Closing the upstream connection does not guarantee Ollama stopped computing.
- LAN access/deployment has not been validated. No database backup-and-restore has been demonstrated. A source checkpoint is not a database backup.
- Browser refresh opens a new blank conversation. It is not an acknowledged cancellation. Use the in-page **Refresh saved history** action to reconcile the currently open conversation; saved conversations cannot yet be browsed/reopened through the UI.

## Startup

Use the current localhost development setup from the [frontend integration guide](./FRONTEND_INTEGRATION_README.md):

Backend, from the repository root, in a separate PowerShell terminal:

```powershell
Set-Location "P:\Repos-Github\Local-First-AI"
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Frontend, in another PowerShell terminal:

```powershell
Set-Location "P:\Repos-Github\Local-First-AI\frontend"
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/`. Ollama must already be running. Do not assume port 8000 serves the streamed React application; its root serves the older interface.

## Resume guidance

On a future thread, inspect current Git status and code first, preserve completed work, and do not repeat completed tests or rebuild earlier increments without a specific reason. Do not infer completion of unimplemented roadmap items from the October 10 proposal. No next feature is currently selected.
