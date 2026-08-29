# Meta webhook receiver

## Local setup

1. Copy `.env.example` to `.env` and fill in `VERIFY_TOKEN` and `META_APP_SECRET`.
2. Run `npm ci` followed by `npm start`.
3. Configure Meta to call `GET` and `POST` on the public HTTPS URL for this service.

`VERIFY_TOKEN` authenticates Meta's callback verification. `META_APP_SECRET`
authenticates every incoming POST through the `X-Hub-Signature-256` HMAC-SHA256
header. Unsigned or incorrectly signed payloads are rejected.

## Production checklist

- Use a platform secret manager for both secrets; never put them in source, images, logs, or CI output.
- Terminate TLS at a load balancer/reverse proxy and set `TRUST_PROXY=true` and `REQUIRE_HTTPS=true`.
- Put a WAF/rate-limit policy in front of the service. Signature validation remains the authorization control; do not rely on IP allowlists.
- Replace the in-memory idempotency cache with Redis or Postgres before scaling or adding business side effects. Persist/enqueue an event before returning `200` and add a retry/dead-letter policy.
- Log structured metadata only; never message text, phone numbers, tokens, secrets, or complete payloads.
- Pin the container image to an approved digest in deployment and update the supported Node LTS regularly.

## Deploy on Render

The repository includes `render.yaml`, a Render Blueprint that provisions four
resources in the same private network: the public API, the background worker,
Render Postgres, and Render Key Value (Redis-compatible). Both the API and
worker use the same source code but run independently.

1. Push this `merlynSales` folder to a private GitHub repository. Do not commit
   `.env` files or any real credential.
2. In Render, select **New > Blueprint**, connect that repository, and approve
   the resources shown by `render.yaml`.
3. During creation, enter the requested secret values:
   `META_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_GRAPH_API_VERSION`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
   `FRONTEND_ORIGIN`.
4. After the first API deploy, Render runs `npm run migrate` automatically and
   creates the application schema. Check the API deploy log for
   `Migration applied`.
5. Open the API's public URL and confirm `https://YOUR_API.onrender.com/health`
   returns `{ "status": "ok" }`.
6. In the API environment variables, copy the generated `VERIFY_TOKEN` into
   the Meta webhook configuration. Use `https://YOUR_API.onrender.com/` as both
   the callback URL and webhook endpoint. Never expose `OUTBOUND_API_KEY` in
   the UI.

`FRONTEND_ORIGIN` must be the final UI URL exactly, for example
`https://app.example.com`, without a trailing slash. Render terminates HTTPS at
its proxy; the Blueprint enables `TRUST_PROXY` so the API accepts those secure
requests.

The UI is a separate Render service because it is in the sibling `ui` folder.
Push it as its own repository and create a second Blueprint from
`ui/render.yaml`. Set `NEXT_PUBLIC_API_URL` to the API URL from step 5, then
set the API's `FRONTEND_ORIGIN` to the UI URL Render assigns. Redeploy the UI
after changing a `NEXT_PUBLIC_*` variable because those values are compiled
into the browser bundle.

## Current scope

The receiver verifies, validates, deduplicates within one process, and acknowledges events. It does not yet perform sales or messaging actions, nor does it include a managed queue/database because those require production infrastructure choices.

## Send WhatsApp messages

All outbound endpoints require an `x-api-key` header matching `OUTBOUND_API_KEY`.
They use `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` server-side, so
those credentials are never exposed to API clients.

| Endpoint | Purpose |
| --- | --- |
| `POST /messages/text` | Text message |
| `POST /messages/video` | Video by Meta media ID or HTTPS link |
| `POST /messages/attachment` | `document`, `image`, `audio`, or `sticker` by media ID or HTTPS link |
| `POST /messages/document` | Document attachment shortcut |
| `POST /messages/cta-url` | Interactive call-to-action URL button |

Text example:

```json
{ "to": "5215555555555", "body": "Hola, gracias por escribirnos", "previewUrl": false }
```

Video example:

```json
{ "to": "5215555555555", "id": "META_MEDIA_ID", "caption": "Tu video" }
```

Document example:

```json
{ "to": "5215555555555", "type": "document", "link": "https://example.com/catalogo.pdf", "filename": "catalogo.pdf" }
```

CTA URL example:

```json
{ "to": "5215555555555", "body": "Consulta nuestro catálogo", "buttonText": "Abrir catálogo", "url": "https://example.com/catalogo" }
```

Normal WhatsApp conversation-window and template rules still apply. When Meta
returns a policy or conversation-window error, use an approved template rather
than retrying the same free-form message.

## Conversations, sessions, and worker

Start local PostgreSQL and Redis with `docker compose up -d`. The initial schema
is in `db/migrations/001_initial_schema.sql`. Start the HTTP API with `npm start`
and the worker separately with `npm run worker`.

Create a Supabase project, enable the desired sign-in provider, and configure
`SUPABASE_URL` and `SUPABASE_ANON_KEY`. After the UI signs in with Supabase, it
sends its transient access token once to `POST /auth/session`; this API exchanges
it for a secure HttpOnly `merlyn_session` cookie. Do not persist Supabase access
tokens or `OUTBOUND_API_KEY` in browser storage.

Authenticated UI endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /auth/session` | Exchange `{ "accessToken": "..." }` for a cookie |
| `DELETE /auth/session` | Log out |
| `GET /auth/me` | Current user and organization |
| `POST /settings/whatsapp-account` | Owner connects `{ "phoneNumberId": "..." }` |
| `POST /conversations` | Create/find a contact conversation |
| `GET /conversations` | List conversations |
| `GET /conversations/:id/messages` | List messages |
| `POST /conversations/:id/messages/text` | Queue `{ "body": "..." }` for delivery |
| `POST /conversations/:id/messages/document` | Queue a reusable Meta document `{ "mediaId": "...", "filename": "...", "caption": "..." }` |
| `POST /conversations/:id/messages/audio` | Upload and queue an AAC, M4A, MP3, AMR, OGG, or OPUS audio file (raw body) |
| `GET /conversations/:id/messages/:messageId/media` | Authenticated proxy for received audio and sticker media |
| `POST /settings/catalog-document` | Owner/admin configures the reusable catalog Media ID and automatic trigger |
| `GET /leads/board` | Returns lead columns and their conversation cards |
| `POST /leads/columns` | Owner/admin adds `{ "name": "..." }` to the pipeline |
| `DELETE /leads/columns/:id` | Owner/admin removes a column and moves its leads to the first remaining column |
| `PATCH /leads/:id/column` | Moves a conversation with `{ "columnId": "..." }` |
| `POST /remarketing/images` | Owner/admin uploads a JPEG, PNG, or WebP image to Meta (raw file body) |
| `POST /remarketing/campaigns` | Owner/admin queues a text, image, or image-with-caption campaign for one lead column |

### Lead pipeline

Migration `003_lead_pipeline.sql` adds a configurable sales pipeline per
organization. Existing and new conversations begin in `Primer contacto`; the
initial columns are `Primer contacto`, `Re-Marketing`, `Cotizacion`, and
`Pendiente envio`. The UI uses `GET /leads/board` to draw the board and moves a
lead with drag and drop through `PATCH /leads/:conversationId/column`.

Only owners and admins can add or remove columns. Removing a column never
deletes its conversations: they move automatically to the first remaining
column. At least one column must remain.

### Remarketing campaigns

The UI Remarketing panel uploads images privately through the API, which stores
the resulting Meta Media ID only in the campaign record. A campaign can contain
text, an image, or both (the text becomes the image caption). It queues one
outbound message per eligible conversation in the selected column.

Free-form WhatsApp text and images are limited to the rolling 24-hour customer
service window after the customer's latest inbound message. The API excludes
contacts outside that window and reports their count. Use an approved WhatsApp
template to reach those contacts.

### Reusable catalog document

Upload your PDF to Meta once using its Media API and keep the returned Media ID.
Then, with an authenticated owner/admin session, configure it in this API:

```json
POST /settings/catalog-document
{
  "mediaId": "META_MEDIA_ID",
  "filename": "catalogo.pdf",
  "caption": "Aquí está nuestro catálogo.",
  "triggerPhrase": "Quisiera ver el catalogo"
}
```

When a new inbound text contains that phrase (case, accents, and punctuation are ignored), the
worker queues a document message using the stored Media ID. The same document
can also be sent manually to any conversation through
`POST /conversations/:id/messages/document`. Meta media IDs can expire or be
deleted; configure a replacement ID if Meta rejects a later send.

The worker reads queued outbound messages, calls Meta, and changes their state to
`sent` or `failed`. This is the path the UI should use; the `/messages/*` endpoints
remain protected for trusted server-to-server integrations.

### Audio and stickers

Incoming audio and sticker webhooks retain their Meta Media ID in the message
record. The authenticated media endpoint requests the temporary media URL from
Meta and streams it to the UI, so Meta access tokens are never exposed to the
browser. The chat composer uploads supported audio files to Meta, creates a
pending `audio` message, and the worker sends it through the outbound queue.

Verified incoming webhooks are also queued. Once an owner connects the deployment's
phone number through `/settings/whatsapp-account`, the worker creates contacts and
conversations for incoming messages and updates delivery states from Meta status
webhooks.

## Manual test: session, account association, and webhooks

Use this checklist with Postman and a terminal. Never place real tokens, cookies,
or app secrets in this README, source control, screenshots, or chat messages.

### 1. Confirm local services

Start PostgreSQL and Redis, then run the API and worker in separate terminals:

```bash
docker compose up -d
npm start
npm run worker
```

Confirm the API responds:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{ "status": "ok" }
```

### 2. Obtain a Supabase access token

In Postman, call the following endpoint using a user created in Supabase
Authentication > Users:

```text
POST https://YOUR_PROJECT.supabase.co/auth/v1/token?grant_type=password
```

Headers:

```text
apikey: YOUR_SUPABASE_ANON_KEY
Content-Type: application/json
```

Body:

```json
{ "email": "you@example.com", "password": "your-password" }
```

Copy only the `access_token` from the response for the next request.

### 3. Create the backend session

In Postman:

```text
POST http://localhost:3000/auth/session
Content-Type: application/json
```

Body:

```json
{ "accessToken": "PASTE_THE_SUPABASE_ACCESS_TOKEN" }
```

Expected response: `201 Created`. Postman must now contain a `merlyn_session`
cookie under the `localhost` domain. Verify it through the **Cookies** button;
Postman sends it automatically in subsequent requests.

### 4. Associate the WhatsApp phone number with the organization

With the same Postman session and cookie:

```text
POST http://localhost:3000/settings/whatsapp-account
Content-Type: application/json
```

Body:

```json
{ "phoneNumberId": "YOUR_WHATSAPP_PHONE_NUMBER_ID" }
```

Expected response: `204 No Content`. This association is required for inbound
messages to become conversations in the UI.

### 5. Test Meta callback verification (GET)

Replace `YOUR_VERIFY_TOKEN` with the local `VERIFY_TOKEN` value:

```bash
curl -G http://localhost:3000/ \
  --data-urlencode 'hub.mode=subscribe' \
  --data-urlencode 'hub.verify_token=YOUR_VERIFY_TOKEN' \
  --data-urlencode 'hub.challenge=verify-me'
```

Expected response body: `verify-me` with HTTP `200`.

### 6. Simulate an incoming WhatsApp webhook (POST)

Run this from the backend folder. Change `YOUR_PHONE_NUMBER_ID` and use a new
message ID on every test; sending exactly the same payload twice correctly
returns `duplicate: true`.

```bash
PAYLOAD='{"object":"whatsapp_business_account","entry":[{"id":"test","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"1312231151967354"},"messages":[{"from":"5212721295406","id":"wamid.TEST_001","timestamp":"1720000000","type":"text","text":{"body":"Webhook test message"}}]}}]}]}'

SIGNATURE=$(PAYLOAD="$PAYLOAD" node - <<'NODE'
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
process.stdout.write('sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(process.env.PAYLOAD).digest('hex'));
NODE
)

curl -i -X POST http://localhost:3000/ \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  --data-binary "$PAYLOAD"
```

Expected response:

```json
{ "received": true, "duplicate": false }
```

Wait a few seconds for the worker, then refresh the UI. A conversation for
`5215555555555` should appear. To test rejection, omit the signature header or
change one character in it; the API must respond with `401 Unauthorized`.
