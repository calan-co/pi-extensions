# Pi-channel fallback UAT runbook

Local Markdown viewer: <http://localhost:8523/docs/pi-channel-fallback-uat.md>

> **Execution record:** this is a procedure, not evidence that a UAT has been
> performed. Complete the evidence template at the end only after executing it.

This runbook validates the approved local `pi-channel` fallback: durable Pi
membership is published to the paired local relay, and the relay automatically
associates equal authenticated Pi and stock session IDs without metadata.
Canonical Pi session-file metadata remains the secondary path for distinct
IDs. Normal operation must **not** use `bind`, an Oppi identifier in Pi, or a
configuration-owner token.

## Preconditions and safety

- Run on macOS as one normal Unix user, with `node`, `pnpm`, Rust, Zellij, and
  Pi installed. Run the relay and Pi under that same user.
- Obtain a fresh, complete, signed `oppi://connect?...` or `oppi://pair?...`
  invite from the pairing authority. It contains the one-time pairing token;
  do not put the invite in shell history, a ticket, or UAT evidence.
- Have one real Pi session and a stock Oppi session with the **same exact
  session ID**. This is the primary automatic-routing precondition and needs
  no metadata lookup. For the optional distinct-ID path instead, Pi must have
  a saved `<pi-session-id>.jsonl` file and authenticated
  `GET /sessions/<stock-session-id>` metadata must supply the same canonical
  absolute `piSessionFile`; its filename ID must equal the Pi session ID.
  Display names, aliases, symlinks, partial IDs, arbitrary metadata, and
  guessed IDs do not qualify.
- Use a disposable clean checkout/worktree for the build. These repositories
  may contain local or untracked work. Inspect with `git status --short`; do
  **not** run `git clean -xfd` in a working checkout. In a disposable clone
  only, first review `git clean -ndx`, then use `git clean -xfd` if needed.
- This runbook deliberately deletes the relay's `oppi-zellij` Keychain entry
  for fresh-pair recovery. Do not use that step if retaining its device
  credential or local subscriptions/bindings matters.

The relay uses a dedicated paired device credential in macOS Keychain. A
configuration-owner token is neither needed nor accepted by this flow: do not
export one, add one to plugin configuration, paste one at a prompt, or try to
repair a `401` by supplying one.

## 1. Build and static validation

Set paths to clean checkouts, then run the following commands. `cargo clean` is
intentional here because this is the disposable UAT checkout.

```sh
export PI_EXTENSIONS="$HOME/dev/pi-extensions"
export OPPI_ZELLIJ="$HOME/dev/oppi-zellij"

git -C "$PI_EXTENSIONS" status --short
git -C "$OPPI_ZELLIJ" status --short

cd "$PI_EXTENSIONS"
pnpm install --frozen-lockfile
pnpm check
pnpm test -- test/pi-channel-unix-socket-transport.test.mjs
# Attention validation: full suite passed when this runbook was updated.
pnpm test

cd "$OPPI_ZELLIJ"
cargo clean
./build.sh
export HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
# Relay tests need the host TLS stack.
cargo test --target "$HOST_TARGET" --features relay
```

Expected: the checks and tests exit zero; the two release artifacts exist at
`target/wasm32-wasip1/release/oppi-zellij.wasm` and
`target/$HOST_TARGET/release/oppi-zellij-relay`. Record the commits and command
output in the template. A clean build does not mean deleting a developer's
untracked work.

## 2. Fresh relay pairing, plugin load, and shared socket

Continue in the relay checkout. The deletion command can return nonzero when
no prior entry exists; that is expected for an actually fresh machine.

```sh
export RELAY="$OPPI_ZELLIJ/target/$HOST_TARGET/release/oppi-zellij-relay"
export PLUGIN_URL="file:$OPPI_ZELLIJ/target/wasm32-wasip1/release/oppi-zellij.wasm"
export PLUGIN_CONFIGURATION='topics=ttr|workflows|support,subscribed_topics=ttr'

security delete-generic-password -s oppi-zellij || true
"$RELAY" pair
# At the hidden prompt, paste the complete signed oppi:// invite; do not paste an owner token.

zellij plugin --configuration "$PLUGIN_CONFIGURATION" -- "$PLUGIN_URL"
```

Expected: pairing reports that the device credential was stored in macOS
Keychain, and Zellij shows the plugin with `ttr`, `workflows`, and `support`.
The initial checked selection is `ttr`. The plugin configuration contains only
local topic names; it contains no capability, invite, device credential, or
owner token.

Use **two shells** for this UAT: Shell A runs the relay and every relay
verification command; Shell B runs the foreground Pi session. In Shell A,
create a stable private UAT directory and export the shared non-secret path:

```sh
export UAT_RUNTIME_DIR="$HOME/.cache/pi-channel-uat"
mkdir -p "$UAT_RUNTIME_DIR"
chmod 700 "$UAT_RUNTIME_DIR"
export PI_CHANNEL_SOCKET_PATH="$UAT_RUNTIME_DIR/socket"

# Required by the relay process; these reference the already-built plugin.
export OPPI_ZELLIJ_PLUGIN_URL="$PLUGIN_URL"
export OPPI_ZELLIJ_PLUGIN_CONFIGURATION="$PLUGIN_CONFIGURATION"

"$RELAY" >"$UAT_RUNTIME_DIR/relay.log" 2>&1 &
export RELAY_PID=$!
sleep 1

test -S "$PI_CHANNEL_SOCKET_PATH"
test "$(stat -f '%Lp' "$UAT_RUNTIME_DIR")" = 700
test "$(stat -f '%Lp' "$UAT_RUNTIME_DIR/capability")" = 600
test "$(stat -f '%Lp' "$PI_CHANNEL_SOCKET_PATH")" = 600
printf 'socket=%s\n' "$PI_CHANNEL_SOCKET_PATH"
```

Expected: all four `test` commands exit zero. `capability` is created by the
relay; never print, copy, pass, or capture its contents. `PI_CHANNEL_SOCKET_PATH`
is a shared non-secret absolute path, not a capability transport.

Without the override, both processes use a verified owned non-group/world
writable `$XDG_RUNTIME_DIR/pi-channel-v1/socket`, falling back to
`/tmp/pi-channel-$(id -u)/socket`. If the fallback is used, substitute that
path in the three `stat` checks. Do not manually remove the runtime directory
or socket while the relay is running.

## 3. Start the one Pi test session in Shell B

Keep Shell A open: it owns `$RELAY`, `$UAT_RUNTIME_DIR`, the relay process, and
all later `bindings`, `subscriptions`, and log commands. Open Shell B and set
only the shared socket path before launching Pi:

```sh
export PI_CHANNEL_SOCKET_PATH="$HOME/.cache/pi-channel-uat/socket"
```

If Shell A used a different stable path, substitute that exact path here. Do
not use `mktemp` separately in Shell B.

Add the Pi extension once, preserving the existing `extensions` array. This
uses Pi's documented settings file and backs it up first:

```sh
export PI_SETTINGS="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json"
cp "$PI_SETTINGS" "$PI_SETTINGS.pi-channel-uat.bak"
node --input-type=module - "$PI_SETTINGS" "$PI_EXTENSIONS/extensions/pi-channel/index.ts" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [settingsPath, extensionPath] = process.argv.slice(2);
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
settings.extensions = [...new Set([...(settings.extensions ?? []), extensionPath])];
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE
```

From Shell B (so Pi inherits `PI_CHANNEL_SOCKET_PATH`), start Pi:

```sh
pi
```

This creates or resumes **one** normal Pi conversation. It is the only Pi
session used in this UAT: do not create a second session with the Oppi CLI, and
do not run `/oppi-mirror` or `/channel` in different Pi sessions. On that
single session's start, the extension publishes its selected-branch snapshot.
In that same Pi session run:

```text
/oppi-mirror start
/channel join ttr
/channel list
/channel diagnostics
```

Expected: Mirror reports that it is live, Pi confirms `Joined channel ttr`, and
`/channel list` includes `ttr`. `/channel diagnostics` reports the shared
absolute socket path, `"connection":"connected"`, a non-null `lastPublish`,
and `lastError:null`; it never prints a capability. In Shell A, independently
confirm the running relay has retained that snapshot without exposing a secret:

```sh
"$RELAY" publisher-snapshots
```

Expected output has the Pi publisher ID and `ttr` in `memberships`. There is no
prompt for an Oppi ID, no `bind` command, and no configuration-owner token. The relay independently receives
the Pi session ID and, when available, a canonical `piSessionFile`. Equal IDs
route without the file; the file is needed only for the distinct-ID metadata
fallback. Do not use manual binding in this normal-flow UAT.

## 4. Positive automatic-route test

1. In Shell A, ensure the relay's local selection includes the test channel:

   ```sh
   "$RELAY" subscribe ttr
   "$RELAY" subscriptions
   ```

   Expected command output includes `["ttr"]` (additional local selections are
   allowed if recorded).
2. In that **same Pi session**, produce a new, uniquely identifiable activity
   (for example, send `ping`). Its active `oppi-mirror` connection mirrors the
   activity to stock Oppi. Do not set a manual binding.
3. Capture the Zellij plugin after the event. Expected: `Latest subscribed
   activity` gains the unique event with topic `ttr`.
4. Verify the automatic cache, without exposing any secret:

   ```sh
   "$RELAY" bindings
   ```

   Expected: an entry has the matching Pi and stock session IDs and
   `"provenance":"exact-id"`. This proves the relay, not Pi, established the
   association. A manual entry (`"provenance":"manual"`) fails this normal-flow
   UAT. For a deliberately distinct-ID UAT, expect `"provenance":"automatic"`
   after verifying the canonical metadata file instead.

If the equal-ID event is absent, verify both IDs exactly; do not compensate
with `bind`. For the distinct-ID variant, verify the metadata contract and
canonical file path instead.

## 5. Negative routing tests

Use a new, unique stock event for every observation so it cannot be confused
with a retained plugin history item.

### Leave test

In Pi, run:

```text
/channel leave ttr
/channel list
```

Expected: Pi confirms the leave and the list no longer includes `ttr`. Produce
a new activity for the same automatically associated stock session. Expected:
the plugin receives no new `ttr` item even though the relay's local selection
may still include `ttr`.

### Unsubscribe test

Rejoin in Pi, wait for the normal snapshot update, then remove the relay-local
selection:

```text
/channel join ttr
```

```sh
"$RELAY" unsubscribe ttr
"$RELAY" subscriptions
```

Expected command output no longer includes `ttr`. Produce another unique event
for the same session. Expected: the plugin receives no new item for it. This
shows that membership and relay-local selection are both required; neither
command sends channel control to Oppi.

## 6. Relay restart recovery

Re-enable the local selection and confirm the Pi membership is still joined:

```sh
"$RELAY" subscribe ttr
"$RELAY" subscriptions
kill -TERM "$RELAY_PID"
wait "$RELAY_PID" || true
"$RELAY" >"$UAT_RUNTIME_DIR/relay-restart.log" 2>&1 &
export RELAY_PID=$!
sleep 1
test -S "$PI_CHANNEL_SOCKET_PATH"
test "$(stat -f '%Lp' "$UAT_RUNTIME_DIR/capability")" = 600
test "$(stat -f '%Lp' "$PI_CHANNEL_SOCKET_PATH")" = 600
```

Do **not** rerun `/channel join`, `bind`, or pairing for this step. The live Pi
publisher detects the closed socket, reconnects, and replays its complete
branch-derived snapshot. Produce one more unique stock activity after the
restart. Expected: it appears in the plugin as `ttr`, and `"$RELAY" bindings`
still reports the exact-ID association after stored equality is revalidated
and Pi replays its authenticated membership snapshot. For the distinct-ID
variant, the live route is revalidated from pinned stock metadata. If Pi was
stopped, start it normally and let `session_start` replay the branch instead of
reconstructing membership by hand.

When finished, stop the relay and remove only the disposable UAT runtime
folder. Restore the Pi settings backup if the extension should not remain
loaded:

```sh
kill -TERM "$RELAY_PID" 2>/dev/null || true
wait "$RELAY_PID" 2>/dev/null || true
mv "$PI_SETTINGS.pi-channel-uat.bak" "$PI_SETTINGS"
rm -rf "$UAT_RUNTIME_DIR"
```

## Troubleshooting

| Symptom | Check and recovery |
| --- | --- |
| `401`, WebSocket authorization failure, or `stock session metadata request returned HTTP 401` | The paired device credential is absent, revoked, or wrong for the stock service. Stop the relay, obtain a fresh signed invite, and repeat the fresh pairing step. Pairing itself validates the authenticated event stream. Do **not** add a configuration-owner token, copy a browser token, or put a credential in `OPPI_ZELLIJ_PLUGIN_CONFIGURATION`. |
| `invalid invite envelope encoding`, `invalid invite envelope JSON`, signature/version error, or `pairing token missing` | Paste the complete unmodified `oppi://` invite at the hidden prompt. Do not extract a token from it, URL-decode/re-encode it, or substitute an owner token. Request a new invite if it was consumed or expired. |
| Relay cannot create socket/capability, Pi reports a local-adapter permission error, or `publisher-snapshots` is empty after a join | Run `/channel diagnostics` in the same Pi session. Confirm its socket path is the shared path, its connection is `connected`, and `lastPublish` is non-null; record only these fields, never a capability. Confirm both processes inherit the same absolute `PI_CHANNEL_SOCKET_PATH`; its parent must be an owned `0700` directory. Start the relay first and run the `test`/`stat` checks. If Pi started first, leave it running: the publisher retries and replays its branch snapshot once the relay starts. Stop the relay before removing a damaged UAT directory, recreate it at `0700`, then restart relay and Pi. |
| Plugin shows `Relay error: Invalid local subscription ...` or no selection update | Load the exact plugin configuration shown above. The only accepted relay control envelope is `{"type":"oppi.local_subscription","channels":[...]}`; no extra fields or capability belong in it. Check `"$RELAY" subscriptions`, then create a new event to cause the relay to forward current local selection. |
| No positive route, or `bindings` is empty/ambiguous | For the normal equal-ID route, verify the authenticated Pi and stock IDs are byte-for-byte equal and `/channel list` includes `ttr`; no metadata is required. For the distinct-ID variant, verify paired pinned-TLS metadata contains an exact canonical regular `piSessionFile` whose filename ID equals the Pi ID. Do not use display names, a raw path, partial IDs, or `bind` to make the normal-flow test pass. |

## Security boundary

The `0600` capability file and socket plus the `0700` parent prevent other Unix
users from connecting. They are defense in depth, **not** isolation from a
malicious process under the same Unix UID: that process can read the capability
file. The capability must remain only in local NDJSON; never put it in an
argument, URL, environment variable, log, screen capture, Zellij pipe, Oppi
request, or UAT evidence. The paired device credential remains relay-owned in
Keychain and must also be redacted from evidence.

## UAT evidence template

Copy this template into the test record after execution. Redact invites,
capabilities, device credentials, hostnames if required, and raw private paths.

```text
Pi extensions commit: <commit>
Oppi-zellij commit: <commit>
Executor/date/macOS version: <value>
Pi/Zellij/Rust/Node versions: <values>
Clean-checkout or worktree location: <redacted path>

Build/static commands and exit status:
- pnpm check: <status + output reference>
- pnpm test -- test/pi-channel-unix-socket-transport.test.mjs: <status + output reference>
- pnpm test (attention validation; passed at this runbook update): <status + output reference>
- ./build.sh and cargo test --target "$HOST_TARGET" --features relay: <status + output reference>

Pairing recovery:
- Prior Keychain entry removed or absent: <yes/no>
- Fresh signed invite used at hidden prompt: <yes/no; do not attach invite>
- Configuration-owner token supplied: no
- Pairing/event-stream validation observation: <redacted output>

Plugin and socket:
- Plugin URL/configuration (secrets redacted): <value>
- Shared PI_CHANNEL_SOCKET_PATH (path redacted): <value>
- Parent/capability/socket mode checks: <700/600/600 and command output>
- Relay started before Pi: <yes/no>
- Pi extension loaded and session-start snapshot observed: <observation>
- Pi `/channel diagnostics` connection/lastPublish/lastError (no capability): <observation>
- Relay `publisher-snapshots` membership observation: <redacted output>

Automatic positive route:
- Pi session ID / stock session ID (redacted): <values>
- Canonical session-file contract independently verified: <yes/no + method>
- Manual bind invoked: no
- `bindings` provenance: automatic
- Unique positive event marker and plugin observation: <marker + screenshot/log reference>

Negative tests:
- `/channel leave ttr` marker; no new plugin event: <evidence>
- `unsubscribe ttr` marker; no new plugin event: <evidence>

Restart recovery:
- Relay PID stopped and restarted; socket mode checks passed: <evidence>
- No join/bind/pair repeated before recovery event: <yes/no>
- Unique post-restart event appears with `ttr`: <evidence>
- Automatic binding persisted and live metadata was revalidated: <evidence>

Failures/deviations and cleanup performed: <value>
Residual risks accepted: same-UID process can read the 0600 capability.
```
