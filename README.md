# Workspace App — Collaborative Documents + Real-Time Chat

---

## Tech Stack

| Layer               | Technology                                  |
|---------------------|---------------------------------------------|
| Runtime             | Node.js (>= 18)                             |
| HTTP framework      | Express 5                                   |
| Real-time transport | `ws` (WebSocket, manual HTTP upgrade)       |
| Database            | PostgreSQL 17                               |
| ORM                 | Sequelize 6                                 |
| Cache / Pub-Sub     | Redis 7 (`redis` v5 client)                 |
| Auth                | `jsonwebtoken` (HS256), `bcryptjs`          |
| Rate limiting       | `express-rate-limit` + `rate-limit-redis`   |
| Infra (local)       | Docker Compose (Postgres + Redis)           |
| Dev tooling         | `nodemon`, `dotenv`                         |

---

## Getting Started

### Prerequisites

- Node.js >= 18
- Docker + Docker Compose (for Postgres and Redis)
- `curl` and optionally [`jq`](https://jqlang.github.io/jq/) for the test commands below

### 1. Clone and install

```bash
git clone <repo-url>
cd chat-app
npm install
```

### 2. Configure environment

Create a `.env` file in the project root. It must define the following keys (values are yours to choose — never commit this file; it is already in `.gitignore`):

| Variable            | Purpose                                                        |
|---------------------|----------------------------------------------------------------|
| `POSTGRES_USER`     | Postgres superuser for the Docker container                    |
| `POSTGRES_PASSWORD` | Password for that user                                         |
| `POSTGRES_DB`       | Database name created on first container start                 |
| `DATABASE_URL`      | Postgres connection string used by Sequelize                   |
| `REDIS_URL`         | Redis connection string used by cache, pub/sub and rate limiter |
| `JWT_SECRET`        | Signing secret for access tokens                               |
| `PORT`              | HTTP port for the API server (defaults to `3000`)              |

> Note: `docker-compose.yml` publishes Postgres on host port **5433** (container `5432`) and Redis on **6379**. `DATABASE_URL` must point at the host-published port.

### 3. Start infrastructure

```bash
docker compose up -d
docker compose ps        # wait for postgres healthcheck to report healthy
```

### 4. Run the server

```bash
npm run dev     # nodemon, auto-restarts on change

On boot the server runs `sequelize.sync({ alter: true })`, deriving the schema from the models. This is a development convenience — a production deployment should use migrations instead.

### 5. Verify

```bash
curl -s http://localhost:3000/health
# {"status":"UP","database":"OK","redis":"OK"}
```

### 6. Run multiple instances (to exercise the scale-out path)

```bash
PORT=3000 npm start
PORT=3001 npm start     # second terminal
```

Both instances share Postgres and Redis. Clients connected to different instances still receive each other's events via Redis Pub/Sub.

---

## Database Schema

| Table              | Purpose                                     | Key Relations                                                  |
|--------------------|---------------------------------------------|----------------------------------------------------------------|
| `Users`            | User accounts and credentials               | Has many `WorkspaceMembers`, `Documents`, `Messages`           |
| `Workspaces`       | Top-level team container                    | Has many `WorkspaceMembers`, `Documents`, `Messages`           |
| `WorkspaceMembers` | Junction table carrying the permission role | Belongs to `Users` and `Workspaces`; role ∈ owner/editor/viewer |
| `Documents`        | Collaboratively edited documents            | Belongs to `Workspaces` (cascade delete) and creating `User`   |
| `Messages`         | Chat messages, one channel per workspace    | Belongs to `Workspaces` (cascade delete) and authoring `User`  |

Documents carry a monotonically increasing integer version used for optimistic locking. Messages are indexed on workspace + creation time to keep history reads cheap.

---

## API Reference

Base URL: `http://localhost:3000`

All routes except `/health` and `/api/auth/register|login` require a bearer token. Every response carries an `X-Correlation-ID` header, echoed from the request's `X-Correlation-ID` if supplied, otherwise generated.

### Auth

#### `POST /api/auth/register`

**Purpose:** Create an account and return an immediately usable token.

| Table   | Operation | Purpose                                  |
|---------|-----------|------------------------------------------|
| `Users` | Read      | Check whether the email is already taken |
| `Users` | Write     | Create the account with a hashed password |

**Business Logic**

1. **Field allowlisting** — `email`, `name`, `password` are picked explicitly; the raw request body is never passed to the ORM (mass-assignment guard).
2. **Validation** — all three fields required; password minimum 8 characters. Returns `400` otherwise.
3. **Uniqueness check** — reads `Users` by email; returns `409` if already registered.
4. **Hashing** — bcrypt with 10 salt rounds. The  plaintext is never stored.
5. **Write + token** — creates the user, signs a 7-day HS256 JWT carrying id, email and name.
6. **Response** — `201` with the public user projection and the token. The password hash is excluded at the model level by a default scope, so it cannot leak into a response body by accident.

**Error paths:** `400` validation · `409` email taken · `500` write failure

#### `POST /api/auth/login`

**Purpose:** Exchange credentials for a token.

| Table   | Operation | Purpose                                              |
|---------|-----------|------------------------------------------------------|
| `Users` | Read      | Load the account including its hash, via an explicit scope |

**Business Logic**

1. **Validation** — `email` and `password` required, else `400`.
2. **Credential lookup** — reads `Users` through the `withPassword` scope, the only path that exposes the hash.
3. **Comparison** — bcrypt compare. A missing user and a wrong password return the same `401`, so the endpoint does not act as an account-existence oracle.
4. **Response** — `200` with user projection and a fresh token.

**Error paths:** `400` missing fields · `401` invalid credentials · `500` failure

#### `GET /api/auth/me`

**Purpose:** Resolve the caller's identity from their token.

| Table   | Operation | Purpose                              |
|---------|-----------|--------------------------------------|
| `Users` | Read      | Load the account named in the token  |

Returns `401` without a valid bearer token, `404` if the token references a deleted account.

---

### Workspaces

#### `POST /api/workspaces`

**Purpose:** Create a workspace and make the caller its owner.

| Table              | Operation | Purpose                                  |
|--------------------|-----------|------------------------------------------|
| `Workspaces`       | Write     | Create the workspace                     |
| `WorkspaceMembers` | Write     | Create the caller's `owner` membership   |

**Business Logic**

1. **Validation** — `name` required, else `400`.
2. **Transactional creation** — both writes run inside one Sequelize transaction. A workspace can never exist without an owner, and an orphan membership can never exist without its workspace.
3. **Response** — `201` with the created workspace.

**Error paths:** `400` missing name · `500` transaction rollback

#### `GET /api/workspaces`

**Purpose:** List only the workspaces the caller belongs to.

| Table              | Operation | Purpose                                    |
|--------------------|-----------|--------------------------------------------|
| `WorkspaceMembers` | Read      | Find the caller's memberships              |
| `Workspaces`       | Read      | Join in the workspace details for each one |

Scoping happens at the query level rather than by post-filtering, so a non-member's workspaces are never loaded at all. Each row is returned with the caller's role.

#### `GET /api/workspaces/:workspaceId`

**Purpose:** Fetch one workspace plus the caller's role in it.

| Table              | Operation | Purpose                  |
|--------------------|-----------|--------------------------|
| `WorkspaceMembers` | Read      | Membership check          |
| `Workspaces`       | Read      | Load the workspace record |

`workspaceId` is validated as a UUID by a `router.param` guard before it reaches Postgres — a malformed id returns `400` instead of surfacing a cast error as a `500`.

**Error paths:** `400` non-UUID id · `403` not a member · `404` not found

#### `GET /api/workspaces/:workspaceId/members`

**Purpose:** List everyone in the workspace with their roles. Any member may read.

| Table              | Operation | Purpose                        |
|--------------------|-----------|--------------------------------|
| `WorkspaceMembers` | Read      | Membership check, then the roster |
| `Users`            | Read      | Attach id, email and name to each member |

#### `POST /api/workspaces/:workspaceId/members`

**Purpose:** Invite a user by email, or change an existing member's role. **Owner only.**

| Table              | Operation      | Purpose                                        |
|--------------------|----------------|------------------------------------------------|
| `WorkspaceMembers` | Read           | Verify the caller is an owner                  |
| `Users`            | Read           | Resolve the invitee by email                   |
| `WorkspaceMembers` | Write / Update | Create the membership, or update its role      |

**Business Logic**

1. **Role gate** — `requireWorkspaceRole("owner")`; any other role gets `403`.
2. **Validation** — `email` required; `role` must be one of `owner`, `editor`, `viewer` (defaults to `editor`). Otherwise `400`.
3. **Invitee lookup** — returns `404` if no account matches the email.
4. **Idempotent upsert** — find-or-create the membership. If it already existed with a different role, the role is updated.
5. **Response** — `201` when newly created, `200` when an existing membership was found or updated.

**Error paths:** `400` validation · `403` not owner · `404` user not found · `500` failure

#### `GET /api/workspaces/:workspaceId/documents`

**Purpose:** List the workspace's documents, most recently updated first. Content is deliberately omitted — only id, title, version, creator and timestamp — so a list view never pulls full document bodies.

| Table              | Operation | Purpose           |
|--------------------|-----------|-------------------|
| `WorkspaceMembers` | Read      | Membership check   |
| `Documents`        | Read      | Document metadata  |

#### `POST /api/workspaces/:workspaceId/documents`

**Purpose:** Create a document. **Owner or editor only.**

| Table              | Operation | Purpose                                   |
|--------------------|-----------|-------------------------------------------|
| `WorkspaceMembers` | Read      | Role check (owner/editor)                  |
| `Documents`        | Write     | Create the document at version 1           |

Title defaults to `"Untitled Document"`, content to an empty string. Returns `201`; a `viewer` gets `403`.

#### `GET /api/workspaces/:workspaceId/me ssages`

**Purpose:** Chat history for the workspace channel — the newest 50 messages, returned oldest-first.

| Table      | Operation | Purpose                          |
|------------|-----------|----------------------------------|
| `Messages` | Read      | Load recent messages (cache miss only) |
| `Users`    | Read      | Attach the author to each message      |

**Business Logic**

1. **Cache read** — checks Redis under a per-workspace key. A hit returns immediately without touching Postgres.
2. **Cache miss** — reads the newest 50 messages with their authors, reverses them to chronological order, serializes.
3. **Cache fill** — stores the serialized list in Redis with a 300-second TTL.


#### `POST /api/workspaces/:workspaceId/messages`

**Purpose:** REST fallback for sending chat without holding a socket open. Rate limited.

| Table      | Operation | Purpose                  |
|------------|-----------|--------------------------|
| `WorkspaceMembers` | Read | Membership check      |
| `Messages` | Write     | Persist the message      |

**Business Logic**

1. **Membership check** — any role may post; a non-member gets `403`.
2. **Rate limit** — Redis-backed limiter, 5 requests per minute per IP. Exceeding it returns `429` with `RateLimit-*` headers. The counter lives in Redis, so the limit holds across every server instance rather than per-process.
3. **Validation** — `content` must be a non-empty string, else `400`. It is trimmed before persisting.
4. **Shared write path** — persists through the same service the WebSocket `CHAT_MESSAGE` frame uses, so persistence and cache invalidation can never drift between the two entry points.
5. **Cache invalidation** — deletes the workspace's message cache key.
6. **Fan-out** — publishes a `CHAT_MESSAGE` event to the chat room's Redis channel, so clients holding sockets on *any* instance receive the message.
7. **Response** — `201` with the persisted message, including its server-assigned id and timestamp.

**Error paths:** `400` empty content · `403` not a member · `429` rate limited · `500` failure

---

### Documents

#### `GET /api/documents/:id`

**Purpose:** Fetch one document with its full content and current version.

| Table              | Operation | Purpose                                            |
|--------------------|-----------|----------------------------------------------------|
| `Documents`        | Read      | Load the document and resolve its parent workspace |
| `WorkspaceMembers` | Read      | Membership check against that workspace            |

The workspace is not in the URL, so the document is loaded first and its workspace id handed to the role middleware. Returns `400` for a non-UUID id, `404` if missing, `403` if the caller is not a member.

#### `PUT /api/documents/:id`

**Purpose:** Update a document under optimistic concurrency control. **Owner or editor only.**

| Table              | Operation | Purpose                                       |
|--------------------|-----------|-----------------------------------------------|
| `Documents`        | Read      | Load the document, resolve the workspace, and re-read after the write |
| `WorkspaceMembers` | Read      | Role check (owner/editor)                     |
| `Documents`        | Update    | Conditional write, gated on the caller's version |

**Business Logic**

1. **Load + authorize** — document loaded, workspace resolved, role enforced. `viewer` gets `403`.
2. **Version required** — `version` must be an integer, else `400`. There is no "just overwrite" path.
3. **Conditional update** — the write targets the row only while it still sits at the caller's version, and bumps the version in the same statement. The check and the increment are one atomic database operation, so two concurrent writers cannot both succeed.
4. **Conflict detection** — if zero rows matched, another writer got there first. Returns `409 CONFLICT_DETECTED` along with the current version so the client can re-read and retry.
5. **Fan-out** — on success, publishes `DOCUMENT_UPDATED` to the document room, so sockets stay in sync with edits that arrived over HTTP.
6. **Response** — `200` with the updated document.

**Error paths:** `400` missing/invalid version · `403` viewer or non-member · `404` not found · `409` version conflict · `500` failure

#### `DELETE /api/documents/:id`

**Purpose:** Delete a document. **Owner or editor only.** Returns `204`.

| Table              | Operation | Purpose             |
|--------------------|-----------|---------------------|
| `Documents`        | Read      | Load + authorize     |
| `WorkspaceMembers` | Read      | Role check           |
| `Documents`        | Delete    | Remove the record    |

---

### `GET /health`

Liveness + dependency check. Authenticates against Postgres and reports the Redis connection state. `200` when the database responds, `500` otherwise.

---

## WebSocket Protocol

**Endpoint:** `ws://localhost:3000/ws?token=<jwt>`

The upgrade is handled manually: any path other than `/ws` has its socket destroyed, and a missing or invalid token is answered with a raw `401` before the WebSocket handshake completes.

**Rooms** are addressed as `doc:<documentId>` or `chat:<workspaceId>`. A socket must `JOIN` a room before it can send into it.

### Client → Server frames

| Type              | Payload                                       | Effect                                                     |
|-------------------|-----------------------------------------------|------------------------------------------------------------|
| `JOIN`            | `{ roomId }`                                  | Authorizes, subscribes, registers presence                 |
| `LEAVE`           | `{ roomId }`                                  | Unsubscribes and clears presence                           |
| `DOCUMENT_UPDATE` | `{ documentId, content, expectedVersion }`    | Optimistic-locked edit; editor/owner only                  |
| `CHAT_MESSAGE`    | `{ workspaceId, content }`                    | Persists and fans out a chat message                       |
| `TYPING`          | `{ roomId }`                                  | Ephemeral typing signal to everyone else in the room       |

Unknown frame types are rejected with an `ERROR`, never relayed. The router is a strict allowlist, so a client cannot use the gateway to broadcast arbitrary payloads.

### Server → Client frames

| Type               | When                                                             |
|--------------------|------------------------------------------------------------------|
| `CONNECTED`        | Immediately on connect, carrying the socket id and user          |
| `JOINED` / `LEFT`  | Acknowledging a room join/leave; `JOINED` includes the active user list |
| `PRESENCE_UPDATE`  | Someone joined, left or disconnected from the room               |
| `DOCUMENT_SAVED`   | To the editing socket only, confirming the new version           |
| `DOCUMENT_UPDATED` | To every *other* socket in the document room                     |
| `VERSION_CONFLICT` | To the editing socket only, with the current version and content |
| `CHAT_MESSAGE`     | New chat message, to sender and room alike                       |
| `TYPING`           | Another user is typing                                           |
| `ERROR`            | `BAD_JSON`, `UNKNOWN_TYPE`, `NOT_JOINED`, `BAD_PAYLOAD`, `FORBIDDEN`, `NOT_FOUND`, `BAD_ROOM`, `INTERNAL` |
| `SERVER_SHUTDOWN`  | Sent to all clients before a graceful shutdown closes them       |

---
