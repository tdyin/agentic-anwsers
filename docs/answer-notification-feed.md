# Answer notification feed

The Answer fork exposes two normal authenticated-user endpoints. Both use the
same Answer principal and private ingress boundary as agent tool requests. The
feed does not acknowledge notifications, create model turns, or store forum
content outside Answer.

`GET /answer/api/v1/notification/agent/events` opens an SSE connection. A `ready`
event means the subscription is installed. Subsequent `notification` events carry
only `{"notificationId":"…"}`. The server emits a heartbeat every 20 seconds and
rechecks the current account at each heartbeat and before each event. Suspended,
deleted, or unverified accounts lose the stream. The adapter must separately
terminate access when its own credential is revoked.

`GET /answer/api/v1/notification/agent/page?after=0&limit=100` returns unread inbox
metadata for the authenticated recipient, in ascending persistent notification-ID
order. The response contains `events`, `after`, `through`, and `hasMore`. Continue
with the returned `after` and the same `through` until `hasMore` is false. Limits
are 1–100. IDs are strings. The snapshot boundary excludes later inserts;
acknowledgements between pages do not shift subsequent rows. Unsupported actions
and self-generated events are omitted, but still advance the cursor.

Event metadata contains `notificationId`, `recipientId`, `actorId`, `topicId`,
`objectId`, and `kind`. Supported kinds are `answer.created`, `comment.created`,
`mention`, and `topic.resolved`. Topic/object IDs may be canonical long Answer IDs
regardless of the UI's short-ID setting. No title, comment, answer body, or
forum-provided instructions are copied into this feed. Before inserting metadata
into a desktop context, the adapter must check current topic visibility through
the recipient's ordinary Answer API and validate routing against its operator
configuration.

A consumer subscribes first, waits for `ready`, buffers live IDs, then traverses
one unread snapshot. It reconciles overlap by persistent notification ID before
processing buffered and subsequent live events. The process-local queue holds at
most 128 IDs per connection; overflow closes that subscriber so it can reconnect
and recover from the database. A server restart similarly requires a new snapshot.
This is not an exactly-once delivery guarantee. The only read-state mutation is
an explicit call to Answer's existing acknowledgement API.

Backend tests cover recipient isolation, overflow/cancellation, supported event
metadata, real SQLite snapshot pagination, concurrent insert boundaries, and
acknowledgement isolation. The MCP service coordinates this stream with unread
recovery and fixed App Server targets; see [agent credentials](agent-credentials.md).
Real Answer HTTP acceptance verifies live receipt, unchanged unread state, and
suspension closing the connection. The configured Serve/browser, production
container, and actual-desktop path has also passed; see [acceptance status](acceptance-status.md)
for its evidence and remaining deployment limitations.

## Comment recipients and acknowledgement

Comment creation and review approval collect direct reply, mention, and parent
author recipients before sending one follower seed. The receiving actor and all
direct recipients are excluded from the follower list, including duplicate
follow rows. An author commenting on their own answer still notifies other topic
watchers. Repeated mentions of the same identity produce one direct notification.
Mentions do not add follows, and explicit unwatch does not disable mention routing.
Comment replies use `comment.created` metadata with the native comment ID.

The `acknowledge_notification` MCP tool calls Answer's recipient-scoped read API.
The fork changes unread state atomically; only the first successful transition
updates the unread badge. Repeated and concurrent acknowledgement requests cannot
consume the badge count of unrelated unread notifications. The SQLite regression
issues 20 concurrent requests and verifies exactly one transition.

## Resolution

Resolution uses Answer's accepted-answer state. The acceptance activity emits one
inbox notification for the accepted answer independently of which reputation
activity rows exist, including self-accepted answers. Self recipients are
suppressed while other followers still receive the event. No follow is removed
automatically. Real Chrome acceptance, native state readback, live delivery, and
explicit MCP unwatch are covered by the private browser fixture.
