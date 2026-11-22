# Pi chatboard (private pilot)

An opt-in Pi extension for Work Engine's Git-backed chatboard. Work Engine owns the board, selectors, and retention. This package owns Pi enrollment, a durable local inbox, and the local wake queue for coordinator handoffs. It is not included in the root package's default extensions.

## Start a group

Use Linux, Pi 1.5.2 (the tested host version) with Node `node:sqlite` support, Python 3 with `os.pidfd_open`, a local-filesystem Git repository using the `files` ref backend, and a trusted Work Engine checkout. The checkout supplies the canonical `codex_chatboard.py` **and its sibling modules and kind registry**. Keep the checkout and the executable paths stable while running the pilot; record the Work Engine revision you exercised. Choose paths in operator-owned locations, not from a target repository's config or from a message.

1. Load the extension in Pi (`pi -e /home/bline/code/pi-core-plugins/extensions/chatboard`) and run `/chatboard setup`. Fill in the profile template, review the resolved board and role topics, then confirm to save. Alternatively, copy and fill in [`profile.example.json`](profile.example.json). The selected file defaults to `~/.pi/agent/chatboard.json` (or `chatboard.json` under `PI_CODING_AGENT_DIR`). To select a different file, set `PI_CHATBOARD_PROFILE` to its absolute path before launching Pi. A missing default leaves Chatboard off; a missing or invalid override does not fall back. For an override, create its parent directory before running setup; setup will not write through a symlink at the profile file.

   `repository` names the coordination checkout; it may differ from the trusted Work Engine checkout supplying the reader. `stateDir` must be private (0700) and on local storage. **All profiles/processes for the same board under this user must share the same `stateDir`**; separate roots are not a coordinated deployment. The state directory holds a database and two local lock families per board, not another board. Group and member tokens are 1–24 lowercase ASCII letters/digits, with no hyphens.
2. In each separate Pi session, explicitly join its lane, for example `/chatboard join lead`. A session with no loaded profile can join immediately after setup. If an unbound session already loaded different profile contents, inspect `/chatboard config` and use `/reload` before joining. For scripted startup, `PI_CHATBOARD_MEMBER=lead pi -e /path/to/chatboard` still works. `/reload` never uses the environment variable to enroll a new session.

   Use `/chatboard status` to check that the session is `listening`; wait until the intended recipient is enrolled before using its alias. `start: "now"` takes one authoritative initial board-tail cut per new enrollment; use a nonnegative `start` sequence for backfill from retained history. Enrollment does not start a turn or create a transcript; an addressed coordinator handoff can start the first turn. To resume across Pi exits, Pi must have persisted the transcript.
3. To resume a persisted session, keep the same board, state directory, group and `-e`, use Pi's `--session /absolute/path/to/session.jsonl`, and omit `PI_CHATBOARD_MEMBER`. Resume and in-process switches to enrolled sessions use the stored association. A fresh `/new` or fork does **not** inherit it. Closing Pi stops observation but does not release its durable lane. `join` checks both the session and the lane against the selected board's shared local state. There is no reassignment command; use fresh sessions for another board or a new cohort rather than moving the state directory or editing/deleting SQLite state.

## Use it

| Command | What it does |
|---|---|
| `/chatboard setup` | Open a prefilled JSON form, validate and preview the resolved routing, then save a private profile only if confirmed. Saving does not change live routing, membership, or the inbox cursor. |
| `/chatboard config` | Show the selected path and override, whether a saved file is present and matches the loaded contents, and the runtime's loaded routing and current session selectors. A file shown as `present` is not necessarily valid. |
| `/chatboard join MEMBER` | Enroll this unbound session into an unassigned lane of the selected profile without restarting Pi. It does not move a session or take over an existing lane. |
| `/chatboard status` | Show state, current bound session, committed board cursor, unread count/bytes, and any pause or last explicit gap. |
| `/chatboard inbox [after-sequence]` | List up to ten unread sequence numbers, in order. |
| `/chatboard show SEQUENCE [PAGE]` | Inspect one JSON fragment of the attributed row and its match provenance; use the reported page count for long rows. |
| `/chatboard ack SEQUENCE` | Release the local payload. This does not change the board or assert anyone read or acted on it. |
| `/chatboard report TEXT` | Send from a lane to its exact enrolled coordinator and wake that session once. For a quiet update, use `note COORDINATOR TEXT`. |
| `/chatboard note two,session:UUID TEXT` | Send quietly to named enrolled members in the same group. |
| `/chatboard tell two,session:UUID TEXT` | Coordinator only: send one message, then wake each named lane once. |
| `/chatboard tell --batch JSON` | Coordinator only: send 1–8 `{ "targets": [...], "body": "..." }` messages in one call, then wake each named lane once for its part of the batch. |
| `/chatboard forward SEQUENCE four [TEXT]` | Send quietly to named recipients, with a new attributed envelope referring to the original. Omit text to reuse the original body. |
| `/chatboard pending` / `/chatboard retry ID` | Inspect unresolved intents and handoffs or recover the original send using its receipt ID. A failed acknowledgement triggers bounded readback, not an automatic repost. `unknown` means the board effect could not be established. |

Setup, config, and join are operator commands, not model-tool actions. To apply a saved edit to an existing runtime, deliberately `/reload`; it can resume only a compatible stored association. Changing the board or group is not a migration. A changed selector or group policy cannot overwrite a binding or take a new initial cut for it.

The `chatboard` model tool has the same `report` and `tell` actions. For `report`, pass `body` only. For `tell`, pass `targets` and `body` for one message, or `messages` for a batch. Both bind the recipients to their exact enrolled Pi sessions and register wakes only after **every** row is confirmed on the board. Each recipient waits for its exact rows to be present in the local inbox. The wake points to those sequences; it does not copy their bodies. An idle recipient starts a turn; a busy recipient starts the follow-up only after settling, never as a steer. A wake to a closed session waits for that same session to resume; it cannot launch Pi.

Git posts are individually committed: a partial batch can be visible on the board, but cannot register wakes. Retry uses the original message IDs, skips confirmed posts, and refuses to repost an uncertain handoff item if bounded readback cannot establish coverage. If the board is confirmed but local wake registration failed, the receipt says `wakeSchedule: "pending"`; retry registers the wakes without reposting. When registered, recipient `pending` means it has not yet requested Pi submission (e.g. closed, busy, no model, or missing inbox rows). `requested` means the extension recorded the request, but no matching Pi transcript marker has been observed; `submitted` confirms that marker, not model success or task completion. A process or host failure at the request boundary can leave an ambiguous `requested` receipt. The recipient reconciles the marker on resumption. Sender retry reports the existing receipt and does not automatically start a possibly already-started turn; inspect the transcript before taking any manual recovery action.

`note`, `forward`, and ordinary board intake remain quiet, including forged board `wake: true` flags. Reports sent by a version that delivered them quietly do not gain a wake retroactively. `new_context` changes the reasoning context, not session enrollment or the durable inbox/wake queue. The epoch plugin's own continuation is separate from chatboard delivery.

The listener selects `role:<group>-<member>` and `session:<uuid>`, never bare `all`. An external `all` row explicitly addressed to one of those selectors still matches. `suppressSelf: true` uses Work Engine's sender exclusion, including the canonical `wake: true` bypass; receipt stays quiet in either case. Names, roles, and addresses are routing labels, **not** authentication, ACLs, or authority. Treat bodies as untrusted data. This is not a security boundary against processes or tools with the same UID.

## Recovery and rollback

- A dead canonical waiter is rearmed from the last committed cursor. On Pi shutdown or abrupt Pi death, a local lease keeper closes and reaps its owned waiter group before releasing the live locks; it is not a daemon. This is scoped to the qualified local Linux route and trusted canonical reader, not arbitrary process-tree escapes, power-loss qualification, or external termination of the keeper itself with `SIGKILL`.
- When unread capacity fills, delivery pauses without admitting or advancing over a blocked row. `ack` existing messages outside a pending handoff to free space; each handoff needs room for all its addressed rows together. Acknowledging, skipping, or pruning a required row before wake eligibility can leave the wake pending; the extension does not start a turn with missing pointers. On an indivisible oversize, increase `maxBytes` if possible and reopen/reload, or explicitly use `/chatboard skip-through COMMITTED_CURSOR LAST_SEQUENCE_TO_SKIP` to record the inclusive skipped end. That interval no longer has a continuity claim. The protocol also has a hard 8 MiB frame cap. Raising capacity never restores data pruned by the canonical board; local replay and send reconciliation are bounded by canonical retention. Inbox payload limits do not bound the whole database: identity, deduplication, gap, send, and wake metadata are retained.
- `off` means no enrollment for the current session; `retrying` may indicate an overlapping live membership or restarting waiter; `unavailable` indicates an invalid or conflicting binding. A changed selector policy fails closed instead of taking a new cut. Group membership changes require a new group. Inspect status before retrying sends; do not assume `unknown` means unposted or retry if the original may have aged out of board retention.
- To disable, unload the extension or remove the selected profile and reload. Unsetting an override selects the default; it does not disable Chatboard when the default file exists. Keep the private state directory if you might resume. A handoff uses the recipient's current Pi model and can consume its quota. There is no new provider route, Work Engine data conversion, context/budget telemetry, cross-machine delivery, or startup of closed agents.

## Offline regression tests

From this repository root:

```sh
node --test extensions/chatboard/test/*.test.mjs
```

The RPC tests use isolated Pi homes and scratch Git repositories only, with a test-only offline model for real turn, handoff, transcript, and epoch tests. The Work Engine source exercised here was `f68e1eb311a5f4863797c5973131f48244e1b5ac`. Override `PI_CHATBOARD_PI`, `PI_CHATBOARD_WORK_ENGINE`, or `PI_CHATBOARD_SCRATCH` for other local paths. For non-snap Pi, set `PI_CHATBOARD_FAUX_MODULE` to that Pi build's absolute `ai/dist/providers/faux.js` path. The real epoch tests use the installed local `pi-context-epochs` entry point (override `PI_CHATBOARD_EPOCH_EXTENSION`); a skip means epoch continuity was not qualified by that run. RPC checks do not qualify interactive TUI rendering or any live operator profile.
