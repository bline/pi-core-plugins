# Work Engine context pressure for Pi

Private, opt-in Pi extension for Linux. It uses Work Engine's pinned
`work-engine-context-status control --host pi` reader, including its recent
growth forecast. It doesn't change Pi's context limit, compaction, or rollover
policy and doesn't start or wake a session.

## Try it explicitly

1. Use a trusted immutable reader from Work Engine's
   `skills/manual-orchestration/scripts/provision_context_status.sh` (or an
   existing pin). Record its absolute binary path and SHA-256 from the pin's
   provenance. No Cargo invocation is needed to use an existing pin.
2. Copy [profile.example.json](profile.example.json) to
   `~/.pi/agent/context-pressure.json` (or `context-pressure.json` in the
   directory set by `PI_CODING_AGENT_DIR`) and fill in the reader path and
   digest. Choose the two levels in
   **input tokens**, leaving room before Pi's actual rollover point for
   response tokens and preservation work. The example 125k/150k levels are
   empirical and not portable defaults. `leadCalls` defaults to 3; set it to 0
   to disable the below-band forecast warning.
3. For a pilot, load only in the intended Pi process:

   ```sh
   pi -e /absolute/path/to/pi-core-plugins/extensions/context-pressure
   ```

Loading the parent `pi-core-plugins` package doesn't enable this extension.
If you've already loaded the extension, run `/reload` after creating or
editing the default profile. To choose a different file, set
`PI_CONTEXT_PRESSURE_PROFILE` to its absolute path before launching Pi.
An explicit override replaces the default selection, even if it is invalid
or missing. With neither an override nor a default file, the extension
stays disabled. `/context-pressure status` shows the selected path.

## What happens

Before a natural model request, including a busy tool loop's next call, Pi
checks the most recent completed assistant response on its active transcript
branch. The Work Engine reader supplies the level:

- **Planning:** the configured planning threshold was reached.
- **Approaching:** recent same-epoch growth projects entry into the empirical band.
- **In band:** the latest valid measured input is already in that band.

Only a level higher than the highest one already projected for that branch,
epoch, session, and reader policy is shown. A jump can skip a lower warning.
Forecast oscillations do not repeat it. Projection metadata is recorded as a
non-model Pi custom entry so reload/resume can deduplicate; warning text itself
is request-local, not a transcript message. A projection is not proof that the
provider received it (for example, if a request is canceled). A branch without
that entry, a different policy, or a new compaction epoch can warn again. The
previous epoch's readings are not used for the new epoch.

`/context-pressure status` does a read without starting a model request. It
can show disabled, normal, unavailable, or a pressure level; the observation
and the highest already projected level are separate. After rollover, no
usable first request yet is **unavailable**, not zero input or spare capacity.
No warning or status is proof of safe remaining headroom. The observed input
can lag new user/tool content, and future requests can grow abruptly.

## Scope and coexistence

The extension uses the current Pi session manager, verifies its selection
against the last appended branch, and binds the pinned reader to the transcript
header. Use a single writer per Pi transcript. It has no board subscription,
daemon, or Git/SQLite dependency. The helper runs with a minimal environment
under Linux `/proc`, a two-second process timeout, and bounded output; a
verification or reader failure does not block the Pi run. Reading and pin
verification can add latency to a natural request. Other request-transforming
extensions loaded later can still alter what the model sees.

This can coexist with `pi-context-epochs`, which still owns native rollover
and any percentage-based soft/critical reminders. Those are an independent
policy, so enabling both reminder sources can give two warnings. This extension
does not disable, reconfigure, or replace the epoch plugin or an operational
Work Engine collector already responsible for a session.

## Qualification

`npm test` in this directory runs reader contract checks and offline RPC
fixtures with real Pi, a pinned Work Engine reader, and `pi-context-epochs`.
The model is a local faux provider with deterministic usage. To override the
local fixture locations, set `PI_PRESSURE_TEST_PI`,
`PI_PRESSURE_TEST_FAUX`, `PI_PRESSURE_TEST_EPOCH`,
`PI_PRESSURE_TEST_READER` and `PI_PRESSURE_TEST_SHA256` as needed.
