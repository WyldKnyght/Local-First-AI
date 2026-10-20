# Local-first AI: first assistant-ui frontend integration

## Scope

Complete replacement files, not patches. Targets the reported assistant-ui
0.15.26 installation and the existing Python API. Build compatibility must be
verified on the desktop; this archive has not been compiled or browser-tested.

Includes assistant-ui chat primitives, the external-store adapter, a
Perplexity-style layout, saved conversation reload, and New conversation.
No streaming, memory controls, conversation list, search, attachments, voice,
model selection, authentication, or LAN deployment is added.

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

Consult this section before asking Craig how to start the application.

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

The frontend startup command was supplied directly by Craig. The backend startup
command and model configuration were identified in the local code/documentation
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

Open http://127.0.0.1:5173/ and send a short message. Refresh and verify history.
Then select New conversation and send another message.

New conversation creates another database record; it does not delete the old
conversation. A conversation list is not included yet, so switching back through
the UI is not available in this increment.

Browser localStorage is origin-specific. The frontend at port 5173 will normally
start a new conversation rather than reuse the old page's selection at port 8000.
Old transcripts remain in SQLite. Use 127.0.0.1:5173 consistently rather than
alternating with localhost:5173.

The Vite proxy is development-only. A production build is not yet wired to
FastAPI; this archive does not complete production hosting.

On interruption, refresh and check saved history before resending: the current
backend has no idempotency key or cancellation protocol. Do not treat refresh as
cancelling inference. Keep one browser tab for this first test.

## Failure/recovery validation — 2026-10-20

User-reported results: the baseline request returned `BASELINE OK`. After
quitting Ollama, the next request displayed:

> Ollama request failed. If the response was interrupted, refresh to check saved history before resending.

After restarting Ollama, a request returned `RECOVERY OK`. The failed user
message disappeared when the recovery message was submitted, and the resulting
conversation remained unchanged after browser refresh. No frontend or backend
restart was needed.

While a long response was being generated, Ollama was stopped. The application
displayed:

> Ollama request failed. If the response was interrupted, refresh to check saved history before resending.

After restarting Ollama, a request returned `INTERRUPTION RECOVERY OK`. The
error cleared, no partial answer appeared, and browser refresh left the recovered
chat unchanged.

Conclusion: both the unavailable-service and mid-generation interruption/recovery
paths passed. Explicit user cancellation is not implemented or tested; stopping
Ollama is not an application cancellation feature.

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

Limitations: responses are non-streaming; explicit application cancellation is
not implemented; LAN access is not validated; and memory retrieval is not
automatic. This is a prototype checkpoint, not completion of the full release
plan.

## If anything fails

Paste the full build/lint error or browser error. Do not add cloud credentials,
provider SDKs, CORS wildcards, or expose either server to the LAN as a workaround.
