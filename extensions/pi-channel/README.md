# Pi Channel

`pi-channel` records durable Pi session channel membership.

```text
extensions/pi-channel/index.ts
```

## Commands

```text
/channel join <channel>
/channel leave <channel>
/channel list
/channel diagnostics
```

`join` and `leave` append a `pi-channel` custom session entry. `/channel list`
replays the current Pi branch, so abandoned-branch entries are not reported.
`/channel diagnostics` reports the local publisher socket path, connection
state, last acknowledged membership publish, and its last error. It never
prints the local capability. The command owns only Pi membership: it never
reads an Oppi identifier, display name, or relay state.

## Timeline projection, not a live relay

Pi renders each durable `pi-channel` entry as a bounded joined/left channel
summary. The renderer ignores all non-membership fields, including paths and
tokens, and does not alter the version-1 custom entry data. This transcript
projection is local Pi history, not an Oppi activity feed: it does not route
messages, map sessions, or show live relay state.

## Local membership publisher

The production extension activates its local publisher for every Pi session.
`attachPiMembershipPublisher()` remains the lifecycle seam and publishes only
complete primitive snapshots:

```json
{"piSessionId":"pi-session","piSessionFile":"/canonical/path/pi-session.jsonl","epoch":"publisher-epoch","seq":1,"channels":["ttr"]}
```

The authenticated Unix socket capability, socket, and runtime directory are
owned by the relay. Set the shared non-secret `PI_CHANNEL_SOCKET_PATH` to an
absolute socket path when the relay uses a non-default location; otherwise both
use the verified runtime-directory fallback. The publisher validates the owned
0700 parent and 0600 capability file, retries an initially absent relay with
capped exponential backoff, reconnects after relay restart, and replays a full
snapshot. It cannot assert an Oppi session identity.

The Pi runtime's stable session ID is preferred. When the authenticated stock
WSS session ID exactly equals that published Pi session ID, the relay routes
without any metadata lookup and persists `exact-id` provenance. On restart it
checks the stored equality and waits for a fresh authenticated publisher
snapshot; partial IDs, display names, aliases, and arbitrary metadata never
match.

## Transient attention publisher

The same authenticated local publisher sends relay `attention` frames at
`agent_start` (`active`), `agent_settled` (`waiting`), and `session_shutdown`
(`cleared`): `{v,type:"attention",state,location}`. The location is
`{zellijSessionName, zellijPaneId}` only for `waiting` when inherited
`ZELLIJ_SESSION_NAME` and numeric `ZELLIJ_PANE_ID` are both available;
otherwise it is `null`. Attention never creates or changes durable
`pi-channel` membership entries and never includes a Pi identity, epoch,
sequence, tab, prompt, reason, transcript, or tool output.

Each snapshot also includes `piSessionFile`: `realpath()` resolves it before
publication, or it is `null` when unavailable. For distinct IDs, this remains
the optional secondary path: the relay independently canonicalizes paired stock
metadata from `GET /sessions/<stock-session-id>` and associates only when it
exactly matches the Pi file and that file's `.jsonl` filename ID equals the
published Pi session ID. A stock session without `piSessionFile` is a quiet
non-match. Missing, denied, ambiguous, non-canonical, or mismatched metadata
is dropped without routing. `/channel` never reads an Oppi ID, token, or
configuration owner token.

The relay persists a successful metadata association as a revalidated cache;
manual `bind <pi-session-id|pi-session-file> <stock-oppi-session-id>` remains
recovery only. The local capability excludes other UIDs but is not a boundary
against a hostile process under the same Unix UID.

For the repeatable normal-flow validation procedure (including fresh pairing,
automatic association without `bind`, negative routing, and restart recovery),
see the [Pi-channel fallback UAT runbook](../../docs/pi-channel-fallback-uat.md).
