import { before, test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { createAuth } from "../src/middleware/auth.js";
import {
  validateBook,
  literalRegex,
  parseId,
} from "../src/utils/validation.js";

const config = { authUrl: "http://localhost:3000", audience: "booknook-api" };
let privateKey, authenticate;
before(async () => {
  const pair = await generateKeyPair("EdDSA");
  privateKey = pair.privateKey;
  const key = await exportJWK(pair.publicKey);
  key.kid = "test-key";
  authenticate = createAuth(config, createLocalJWKSet({ keys: [key] }));
});
async function token({
  issuer = config.authUrl,
  audience = config.audience,
  expiration = "5m",
  key = privateKey,
} = {}) {
  return new SignJWT({ email: "reader@example.com", name: "A Reader" })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("reader-1")
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(key);
}
async function check(value) {
  const req = { headers: value ? { authorization: `Bearer ${value}` } : {} };
  const error = await new Promise((resolve) => authenticate(req, {}, resolve));
  return { error, user: req.user };
}
test("a signed JWT yields the verified user identity", async () => {
  const result = await check(await token());
  assert.equal(result.error, undefined);
  assert.equal(result.user.id, "reader-1");
});
test("a missing JWT is rejected", async () =>
  assert.equal((await check()).error.status, 401));
test("an expired JWT is rejected", async () =>
  assert.equal(
    (await check(await token({ expiration: "0s" }))).error.status,
    401,
  ));
test("an incorrect audience is rejected", async () =>
  assert.equal(
    (await check(await token({ audience: "another-api" }))).error.status,
    401,
  ));
test("an incorrect issuer is rejected", async () =>
  assert.equal(
    (await check(await token({ issuer: "https://another-issuer.example" })))
      .error.status,
    401,
  ));
test("a forged signature is rejected", async () => {
  const pair = await generateKeyPair("EdDSA");
  assert.equal(
    (await check(await token({ key: pair.privateKey }))).error.status,
    401,
  );
});
test("the unsigned none algorithm is rejected", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify({ sub: "attacker" })).toString(
    "base64url",
  );
  assert.equal((await check(`${header}.${payload}.`)).error.status, 401);
});
const valid = {
  title: "A Small Story",
  author: "A Reader",
  category: "Fiction",
  description: "A thoughtful little book with a story worth sharing.",
  totalCopies: 2,
  image: "https://i.ibb.co/example/cover.jpg",
};
test("book validation rejects unsafe images and unexpected categories", () => {
  for (const image of [
    "javascript:alert(1)",
    "http://i.ibb.co/cover.jpg",
    "https://evil.example/cover.jpg",
  ])
    assert.throws(() => validateBook({ ...valid, image }), /Upload/);
  assert.throws(
    () => validateBook({ ...valid, category: "Unknown" }),
    /category/,
  );
});
test("copies must be bounded integers", () => {
  for (const totalCopies of [0, -1, 1.5, 10000, "2"])
    assert.throws(
      () => validateBook({ ...valid, totalCopies }),
      /whole number/,
    );
  assert.equal(validateBook(valid).totalCopies, 2);
});
test("only an unchanged existing seed cover may keep a local path", () => {
  const existing = { image: "/images/books/seed.webp" };
  assert.equal(
    validateBook({ ...valid, image: existing.image }, existing).image,
    existing.image,
  );
  assert.throws(() =>
    validateBook({ ...valid, image: "/images/books/another.webp" }, existing),
  );
});
test("search strings are literal instead of executable regex patterns", () => {
  assert.equal(new RegExp(literalRegex("a+b.*[x]")).test("a+b.*[x]"), true);
  assert.equal(new RegExp(literalRegex("a+b")).test("aaab"), false);
});
test("malformed object IDs are rejected before reaching the database", () => {
  for (const value of ["", "abc", "$ne", "a".repeat(23)])
    assert.throws(() => parseId(value));
  assert.equal(String(parseId("a".repeat(24))), "a".repeat(24));
});
