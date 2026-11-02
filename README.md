# Local-First-AI

A Windows-hosted, local-first AI partner prototype. The long-term goal is home-network browser access; the current app is localhost-only and is not a completed release.

## Current status and startup

- [Project status and new-thread handoff](./PROJECT_STATUS.md) - current capabilities, validation evidence, limitations, checkpoints, and resume guidance.
- [Frontend integration and startup guide](./FRONTEND_INTEGRATION_README.md) - exact local startup commands and dated acceptance records.

The React streaming interface is at `http://127.0.0.1:5173/`. FastAPI on port 8000 serves the older non-streaming interface at `/` and retains `/chat` for compatibility. See the startup guide before launching either service.
