# Unix event API

Agentsource serves one read-only, duplex UTF-8 NDJSON endpoint alongside its
GitHub webhook HTTP receiver. Protocol version `v: 1` is endpoint-local. The
checked-in [event catalog](../events.schema.json) uses JSON Schema draft 2020-12;
`$defs.events.anyOf` references the named domain definitions. Generate it with
`bun scripts/generate-events-schema.ts`. Runtime validators and the catalog share
[src/event-schema.ts](../src/event-schema.ts); tests check drift and validate real
socket frames using both Zod and AJV. There is no runtime catalog method.

## Discovery and ownership

`agentsource event-socket` prints the absolute path of the configured live
receiver plus a newline. `AGENTSOURCE_WEBHOOK_SOCKET` selects the same path used
by the built-in consumers; otherwise it is
`~/.local/state/agentsource/webhooks.sock`.

Use `event-socket --socket PATH` to select an exact instance, or
`event-socket --directory DIR` to discover a single live `*.sock` endpoint in a
private directory. Zero matches or multiple live endpoints are errors. Discovery
checks the protocol and never starts a service or reads credentials. A live feed
with unavailable CI remains discoverable. Socket and parent must belong to the
current user, with socket mode 0600 and directory mode 0700. Symlinks, foreign
ownership, and group/other access are rejected. Startup never replaces a live or
foreign socket; only a definitively stale owned socket may be removed.

## Requests and responses

```json
{"v":1,"type":"request","id":"sub","method":"event.subscribe","params":{"events":["deliveries","ci:*"]}}
{"v":1,"type":"response","id":"sub","ok":true,"result":{"subscribed":true,"events":["deliveries","ci:*"]}}
{"v":1,"type":"request","id":"state","method":"state.get","params":{}}
{"v":1,"type":"response","id":"state","ok":true,"result":{"instanceId":"lifetime-id","generation":1,"sequence":12,"inventory":"complete","diagnostics":[],"projections":[]}}
{"v":1,"type":"response","id":"bad","ok":false,"error":{"code":"invalid_params","message":"Invalid method parameters"}}
```

IDs must be nonempty strings up to 128 characters. Responses correlate by ID.
Unknown fields, invalid versions, and invalid method parameters are rejected.
Errors use `invalid_request`, `invalid_params`, `unknown_method`, or
`internal_error`; an invalid/unusable ID is returned as null. Malformed JSON,
invalid UTF-8, and oversized frames close the connection.

Both methods accept omitted or null `params` as `{}`. `event.subscribe {}`
defaults to `["*"]`. An explicit `events` array has 1–32 entries, each at most
128 characters, matching `^(?:\*|[a-z][a-z0-9._:/-]*\*?)$`. Duplicate entries are
removed. Matching is exact, or literal `startsWith` with a single trailing `*`;
`*` matches everything. Unknown well-formed names are valid. There is no regex,
glob expansion, or case folding. Examples: `ci:owner:repo`, `ci:owner:re*`,
`ci:*`, and `deliveries`.

A new successful subscription replaces the connection's filters. Its response
is the replacement boundary; an invalid request leaves the prior subscription
intact. Subscription acknowledgment does not replay CI or deliveries. Further
requests, including repeated `state.get`, are accepted without closing the
connection. Disconnect unsubscribes.

`state.get {}` always returns the bounded full CI projection, independently of
filters. The high-level `snapshotChannels` helper filters this response locally
and closes its own connection when finished.

## Event catalog

| Event name | Data | Semantics |
| --- | --- | --- |
| `ci:<owner>:<repo>` | Context, `emittedAt`, `inventory`, `projection` | Current state: replace one repository's full CI projection. Null removes it. |
| `deliveries` | Context, `emittedAt`, `delivery` | Transient authenticated webhook delivery. No replay, persistence, or snapshot recovery. |

Repository event names are lowercase; provider identity and payload contents
retain their original values. The CI projection retains schema version 3,
revision, projectedAt, owner/repo, paths, availability, repository visibility,
default/primary branches, relevant heads and their check/status contexts,
checkout/branch targets, and diagnostics. The delivery retains schema version 1,
receivedAt, owner/repo, GitHub event, deliveryId, hookId, and the original payload.
The JSON catalog describes every field.

```json
{"v":1,"type":"event","event":"ci:owner:repo","data":{"instanceId":"lifetime-id","generation":1,"sequence":13,"emittedAt":"2026-09-05T12:00:00Z","inventory":"complete","projection":null}}
{"v":1,"type":"event","event":"deliveries","data":{"instanceId":"lifetime-id","generation":1,"sequence":14,"emittedAt":"2026-09-05T12:00:01Z","delivery":{"schemaVersion":1,"receivedAt":"2026-09-05T12:00:01Z","owner":"owner","repo":"repo","event":"push","deliveryId":"github-id","hookId":null,"payload":{}}}}
```

Null projection means removal, never CI success. A projection with
`available:false` means its source is unavailable. CI aggregation and notification
verdict rules are unchanged. The registered repository set is fixed for a daemon
lifetime; changing that set requires a producer restart. No runtime generation
replacement currently exists, so `generation` is always 1.

## Reconciliation and completeness

Each producer lifetime has a random `instanceId`. `sequence` increases globally
across emitted CI and delivery events; filters naturally create gaps. It is not
a timestamp or durable replay cursor. Projection mutation, event sequencing, and
snapshot capture run synchronously on one event loop. The update listener is
installed before initial hydration; updates received during that async read win
over its older results. Listening begins after initialization. Later snapshots
read the retained projection, not an async provider query.

Clients subscribe, await acknowledgment, buffer current-state events, and request
`state.get`. They replace local CI state at the returned watermark, then apply only
newer current-state events. Transient deliveries are delivered independently,
even if their sequence is below the snapshot watermark. On disconnect clients
mark observation unavailable, reconnect, resubscribe, and resnapshot. A changed
instance or generation invalidates prior local state. The TUI replaces its full
map on snapshots, so removed repositories cannot survive a reconnect. The
notifier compares persisted verdicts on snapshot initialization; unchanged
replays do not produce duplicate user notifications.

`inventory` describes projection completeness:

- `complete`: all registered projections are represented, including explicit
  per-repository unavailable results.
- `incomplete`: discovery reported diagnostics or the retention cap was reached.
  Omitted repositories are unknown. Caps are 1024 repositories and 8 MiB of
  serialized projection data. An oversized replacement removes its old retained
  value and publishes null; the feed remains incomplete for that lifetime.
- `unavailable`: source initialization failed. Diagnostics explain the failure;
  the endpoint remains usable, but consumers must not present this as complete CI.

A state snapshot never contains delivery history and cannot recover missed
webhooks. HTTP signature checking, ingestion budgets, CI aggregation, refresh
coalescing, delivery handling, and notification decisions retain their existing
provider semantics.

## Transport bounds

Incoming requests are limited to 1 MiB per frame and 128 simultaneous connections.
Handlers are synchronous after initialization, so there is no pending async
request queue. Requests are processed in wire order. Idle clients that do not
subscribe time out after 5 seconds; subscriptions disable that idle timeout.

Outgoing frames and client input are limited to 32 MiB to accommodate the existing
25 MiB GitHub webhook body limit. Queued output is capped at 64 MiB per connection;
a slow consumer is disconnected without delaying other subscribers. Node's socket
buffer preserves partial writes in order. The client also bounds buffered
initialization events to 64 MiB or 4096 events and applies a 15-second handshake
and snapshot timeout. NDJSON decoding preserves fragmented UTF-8 and rejects
malformed input. These domain-specific bounds intentionally exceed AgentVoice's
smaller outgoing frame/queue sizes.
