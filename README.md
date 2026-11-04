# BookNook API

An Express 5 + MongoDB API for a small online library. Authentication is handled by BetterAuth in the separate Next.js app. This server verifies BetterAuth’s Ed25519 JWT signature, issuer, audience and expiration using its public JWKS endpoint.

## Run

Node.js 22.20+ or 24 LTS and MongoDB Atlas/a replica set are required.

```bash
npm ci
cp .env.example .env
npm run seed
npm run dev
```

Configure `.env` first. `MONGODB_URI` and `MONGODB_DB` must match the client. `BETTER_AUTH_URL` is the canonical client origin; `CLIENT_ORIGIN` permits that origin in CORS; `JWT_AUDIENCE=booknook-api` matches the client auth configuration. Port defaults to 5000.

## Exactly eight application endpoints

| Method | Route          | Access / purpose                                                          |
| ------ | -------------- | ------------------------------------------------------------------------- |
| GET    | `/books`       | Public catalog; `mine=true` requires JWT and filters by verified owner ID |
| GET    | `/books/:id`   | JWT; full details and current-reader borrow state                         |
| POST   | `/books`       | JWT; add a book under the verified owner                                  |
| PATCH  | `/books/:id`   | JWT + ownership; update a book                                            |
| DELETE | `/books/:id`   | JWT + ownership; delete a fully returned book                             |
| POST   | `/borrows`     | JWT; borrow one available copy for seven days                             |
| GET    | `/borrows`     | JWT; verified reader’s active borrows                                     |
| DELETE | `/borrows/:id` | JWT + ownership; return a borrowed book                                   |

BetterAuth’s own auth/token/JWKS endpoints live in Next.js, outside these eight Express routes.

## Data rules

- Books include title, author, category, image, description, total/available copies, verified owner identity and created/updated dates.
- New images must be HTTPS direct links on `i.ibb.co` or `i.postimg.cc`. An unchanged existing seed cover may keep its local URL.
- `GET /books?sort=newest&limit=6` applies MongoDB sort and limit for New Arrivals. Catalog accepts `search`, `category`, `available=true`, `sort=newest|oldest|title`, `page`, `limit` (1–100).
- Ownership and borrower identity come from the verified JWT, never from query-string email or request-body user fields.
- An active `(bookId, userId)` unique index prevents duplicate borrowing. MongoDB transactions group borrow insertion with `$inc: { availableCopies: -1 }` and return deletion with `$inc: { availableCopies: 1 }`.
- A borrow saves book ID/title/image, user ID/name/email, borrow date and a server-generated return date exactly seven days later.
- Repeated returns cannot increment stock twice. Concurrent borrows cannot drive available copies negative.
- Existing active borrows prevent book deletion. Updating Total Copies adjusts Available Copies while retaining the count already borrowed.
- User list/detail responses omit owner email. Reader’s own borrow endpoint remains private.

## Tests

```bash
npm test
npm run test:integration
```

The 12 unit/security tests cover valid, forged, expired, wrong-issuer/wrong-audience and unsigned JWTs plus book inputs. The separate integration suite starts a real test MongoDB replica set with mongodb-memory-server, or uses `TEST_MONGODB_URI` if supplied. It tests CRUD, ownership, duplicate/concurrent borrows, returns and stock accounting. It creates and drops only its uniquely named `booknook_test_*` database.

Unit/security tests passed in the delivery environment. MongoDB process startup was blocked there, so integration execution remains unverified; the suite is included for your configured environment.

## Deploy

Use Render Web Service: build `npm ci --omit=dev`, start `npm start`. Set all required environment values. Use the live client origin for both `CLIENT_ORIGIN` and `BETTER_AUTH_URL`; configure MongoDB Atlas networking for the chosen host. The server waits for database connectivity, a replica-set topology and required indexes before listening. Render supplies `PORT`.

Run `npm run seed` after configuration to load the 26 updated books. Running it again inserts only missing current titles and preserves their existing circulation. When upgrading from the earlier catalog, it retires only the 15 identified old sample titles that have all copies returned, inside MongoDB transactions. Borrowed old sample titles remain until returned; run seed again afterwards. User-added books are preserved. Seed covers are served from the Next.js app’s bundled `/images/books/` folder. Source credits are in `src/data/books.json`.
