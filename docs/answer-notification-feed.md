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
acknowledgement isolation. Full adapter coordination and desktop delivery from
these endpoints remain separate acceptance requirements.
