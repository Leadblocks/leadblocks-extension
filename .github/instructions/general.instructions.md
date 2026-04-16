---
applyTo: "**"
description: "Core guidelines for the Leadblocks Chrome extension. Use when working on any extension file."
---

# Leadblocks Chrome Extension — Development Guidelines

## Architecture

This is a Chrome Manifest V3 side-panel extension that acts as a task queue for LinkedIn automation. It communicates with a Strapi backend via REST API. The extension runs in **dev mode on remote desktops** (not published to the Chrome Web Store).

## Backend Integration

- Always use the dedicated `/api/extension/` endpoints in the Leadblocks Strapi backend for fetching tasks and submitting actions. Do not use generic content-type endpoints or paginated loops when a single-query extension endpoint exists.
- Leverage the existing backend queue flows for all task actions (connect, revoke, disconnect, send follow-up, messaging, etc.). The extension is a UI that drives backend queues — it should never implement its own task-processing logic.
- Keep API calls minimal. Prefer single requests that return all needed data over pagination loops. If an endpoint doesn't exist yet, create one under `/api/extension/` in the backend.

## LinkedIn Safety

- **Never automate DOM interactions on LinkedIn pages from the extension.** The extension is a tool that helps the user perform actions manually — it queues and presents tasks, the user executes them on LinkedIn.
- Do not inject scripts that click buttons, fill forms, or scroll on LinkedIn. This gets accounts flagged.
- Avoid rapid-fire API calls or any behaviour that could correlate with automated LinkedIn activity.
- The URL-matching logic (comparing current tab URL to task profile URL) is for visual guidance only — it must never trigger automatic actions.

## UX & Efficiency

- The primary goal is **speed for the operator**. Every interaction should minimise clicks and keystrokes to get through the task queue as fast as possible.
- Keep the queue/card flow smooth: after an action, advance automatically to the next task.
- Preserve user input across re-renders (focus, cursor position, text values). Calling `render()` rebuilds the DOM, so always restore focus and selection state for the active input after a render.
- Show real-time feedback (toasts, badges, status indicators) so the user never wonders if an action went through.
- Keyboard shortcuts are encouraged for common actions (next, previous, connect, skip).

## Error Prevention

- The extension must be as mistake-proof as possible with a very low learning curve.
- When a field can be auto-filled from LinkedIn data, add an info icon (ℹ) with a tooltip explaining how (e.g. "Hover the name of the prospect to auto-fill").
- Auto-filled values that are scoped to the current task must be **locked once captured** — do not overwrite them when the user hovers over a different profile. Each task card corresponds to one specific prospect, so only the first captured value is correct.
- The user can always manually clear and re-enter a value if the auto-fill was wrong.

## Code Quality

- Plain vanilla JavaScript — no frameworks, no build step. The extension must work as-is when loaded unpacked in Chrome.
- Escape all user-supplied strings rendered as HTML using the `esc()` helper to prevent XSS.
- Use the existing `apiGet` / `apiPost` helpers for all backend calls. Always include the Bearer token.
- Keep state in the single `state` object. Do not introduce separate stores or global variables.
- Use event delegation (the global `setupGlobalDelegation` handler) for actions on dynamically created elements. Per-element listeners in `attachListeners()` are for static filter/nav controls that are recreated on render.

## Language Scope

- Only support **Dutch (NL)** and **English (EN)** for LinkedIn locale detection (connection dates, aria-labels, UI text matching). Do not add German, French, or other languages.

## Deployment Context

- The extension runs **unpacked in developer mode** on remote desktops. There is no build, bundling, or minification step.
- Chrome storage (`chrome.storage.local`) is used for persisting auth tokens across sessions.
- Assume the backend URL may differ per environment — it is configurable via the login form.