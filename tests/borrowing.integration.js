import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import request from "supertest";
import { ensureIndexes } from "../src/db.js";
import { createApp } from "../src/app.js";

let repl, client, db, app, privateKey;
const config = {
  authUrl: "http://localhost:3000",
  audience: "booknook-api",
  clientOrigin: "http://localhost:3000",
};
const bookData = {
  title: "Borrowing Test Book",
  author: "Test Author",
  category: "Fiction",
  description:
    "A genuine database fixture for testing safe library operations.",
  image: "https://i.ibb.co/test/cover.jpg",
  totalCopies: 1,
};

before(async () => {
  let uri = process.env.TEST_MONGODB_URI;
  if (!uri) {
    repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    uri = repl.getUri();
  }
  client = await new MongoClient(uri).connect();
  db = client.db(`booknook_test_${Date.now()}`);
  await ensureIndexes(db);
  const pair = await generateKeyPair("EdDSA");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = "integration";
  app = createApp({
    db,
    client,
    config,
    keyResolver: createLocalJWKSet({ keys: [jwk] }),
  });
});
after(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
  if (repl) await repl.stop();
});
async function auth(user = "owner") {
  return `Bearer ${await new SignJWT({ email: `${user}@example.com`, name: user }).setProtectedHeader({ alg: "EdDSA", kid: "integration" }).setSubject(user).setIssuer(config.authUrl).setAudience(config.audience).setIssuedAt().setExpirationTime("5m").sign(privateKey)}`;
}
async function add(copies = 1) {
  const res = await request(app)
    .post("/books")
    .set("Authorization", await auth())
    .send({ ...bookData, totalCopies: copies });
  assert.equal(res.status, 201);
  return res.body;
}

test("public books uses newest-first order, limit, category and literal search", async () => {
  await add();
  const latest = await add();
  const res = await request(app).get(
    "/books?sort=newest&limit=1&category=Fiction",
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.books.length, 1);
  assert.equal(res.body.books[0]._id, latest._id);
  const literal = await request(app).get("/books?search=%24ne");
  assert.equal(literal.body.total, 0);
});
test("private routes reject missing or invalid tokens and ignore query email spoofing", async () => {
  const book = await add();
  for (const path of ["/borrows", "/books?mine=true", `/books/${book._id}`])
    assert.equal((await request(app).get(path)).status, 401);
  const response = await request(app)
    .get("/books?mine=true&email=owner@example.com")
    .set("Authorization", await auth("intruder"));
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 0);
});
test("only the owner can modify or delete a book", async () => {
  const book = await add();
  const intruder = await auth("intruder");
  assert.equal(
    (
      await request(app)
        .patch(`/books/${book._id}`)
        .set("Authorization", intruder)
        .send(bookData)
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app)
        .delete(`/books/${book._id}`)
        .set("Authorization", intruder)
    ).status,
    403,
  );
});
test("borrow, duplicate rejection and return keep copies exact", async () => {
  const book = await add(2);
  const reader = await auth("reader");
  const borrow = await request(app)
    .post("/borrows")
    .set("Authorization", reader)
    .send({ bookId: book._id, userEmail: "spoofed@example.com" });
  assert.equal(borrow.status, 201);
  assert.equal(borrow.body.userEmail, "reader@example.com");
  assert.equal(
    new Date(borrow.body.returnDate) - new Date(borrow.body.borrowDate),
    7 * 86400000,
  );
  assert.equal(
    (
      await request(app)
        .post("/borrows")
        .set("Authorization", reader)
        .send({ bookId: book._id })
    ).status,
    409,
  );
  assert.equal(
    (await request(app).get(`/books/${book._id}`).set("Authorization", reader))
      .body.availableCopies,
    1,
  );
  assert.equal(
    (
      await request(app)
        .delete(`/borrows/${borrow.body._id}`)
        .set("Authorization", await auth("intruder"))
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app)
        .delete(`/borrows/${borrow.body._id}`)
        .set("Authorization", reader)
    ).status,
    200,
  );
  assert.equal(
    (
      await request(app)
        .delete(`/borrows/${borrow.body._id}`)
        .set("Authorization", reader)
    ).status,
    404,
  );
  assert.equal(
    (await request(app).get(`/books/${book._id}`).set("Authorization", reader))
      .body.availableCopies,
    2,
  );
});
test("concurrent readers cannot borrow the same final copy", async () => {
  const book = await add();
  const headers = await Promise.all([auth("reader-a"), auth("reader-b")]);
  const attempts = await Promise.all(
    headers.map((header) =>
      request(app)
        .post("/borrows")
        .set("Authorization", header)
        .send({ bookId: book._id }),
    ),
  );
  assert.deepEqual(attempts.map((res) => res.status).sort(), [201, 409]);
  assert.equal(
    (
      await request(app)
        .get(`/books/${book._id}`)
        .set("Authorization", headers[0])
    ).body.availableCopies,
    0,
  );
});
test("two concurrent requests by one reader cannot create two borrows", async () => {
  const book = await add(3);
  const header = await auth("concurrent-reader");
  const results = await Promise.all(
    [1, 2].map(() =>
      request(app)
        .post("/borrows")
        .set("Authorization", header)
        .send({ bookId: book._id }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    (await request(app).get(`/books/${book._id}`).set("Authorization", header))
      .body.availableCopies,
    2,
  );
});
test("borrowed copies prevent deletion and constrain total copies", async () => {
  const book = await add(2);
  const owner = await auth();
  await request(app)
    .post("/borrows")
    .set("Authorization", await auth("reader-c"))
    .send({ bookId: book._id });
  await request(app)
    .post("/borrows")
    .set("Authorization", await auth("reader-d"))
    .send({ bookId: book._id });
  assert.equal(
    (
      await request(app)
        .delete(`/books/${book._id}`)
        .set("Authorization", owner)
    ).status,
    409,
  );
  assert.equal(
    (
      await request(app)
        .patch(`/books/${book._id}`)
        .set("Authorization", owner)
        .send({ ...bookData, totalCopies: 1 })
    ).status,
    409,
  );
  const update = await request(app)
    .patch(`/books/${book._id}`)
    .set("Authorization", owner)
    .send({ ...bookData, totalCopies: 4 });
  assert.equal(update.status, 200);
  assert.equal(update.body.availableCopies, 2);
});
test("successful owner update and deletion remove the book", async () => {
  const book = await add();
  const header = await auth();
  const edit = await request(app)
    .patch(`/books/${book._id}`)
    .set("Authorization", header)
    .send({ ...bookData, title: "An Updated Story", totalCopies: 3 });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.title, "An Updated Story");
  assert.equal(edit.body.availableCopies, 3);
  assert.equal(
    (
      await request(app)
        .delete(`/books/${book._id}`)
        .set("Authorization", header)
    ).status,
    200,
  );
  assert.equal(
    (await request(app).get(`/books/${book._id}`).set("Authorization", header))
      .status,
    404,
  );
});
