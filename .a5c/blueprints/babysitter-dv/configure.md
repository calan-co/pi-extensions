# Configure Babysitter-DV

No `ports.mjs` is required for the default adapter. The installed process is the Babysitter↔Doc-Vader adapter: it discovers ready work with `dv work ready --json`, authorizes selection with `dv work select`, records evidence, and uses Babysitter tasks for implementation/review work.

Optional advanced override: pass `configModule` in process inputs to replace the built-in adapter ports with a local `.mjs` module exporting `createPorts(runInput)` or a default function.

With no `itemId` input, `.a5c/processes/babysitter-dv.js#process` repeatedly calls `dv work ready --json` and runs ready candidates until no unblocked work remains or a Babysitter-DV gate halts the run.
