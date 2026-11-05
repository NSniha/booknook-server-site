import { readFile } from "node:fs/promises";
import { ObjectId } from "mongodb";
import { getConfig } from "./config.js";
import {
  connectDatabase,
  ensureBookSlugs,
  transaction,
} from "./db.js";
import { findAvailableBookSlug } from "./utils/book-slug.js";

const legacySeedKeys = [
  "pride-and-prejudice",
  "the-great-gatsby",
  "the-secret-garden",
  "the-time-machine",
  "meditations",
  "little-women",
  "frankenstein",
  "on-the-origin-of-species",
  "alice-in-wonderland",
  "the-art-of-war",
  "the-age-of-innocence",
  "flatland",
  "narrative-of-frederick-douglass",
  "walden",
  "a-room-with-a-view",
];

const config = getConfig();
const { client, db } = await connectDatabase(config);

try {
  const books = db.collection("books");

  const records = JSON.parse(
    await readFile(
      new URL("./data/books.json", import.meta.url),
      "utf8",
    ),
  );

  const ownerEmail = (
    process.env.SEED_OWNER_EMAIL || "library@booknook.example"
  ).toLowerCase();

  const owner = await db.collection("user").findOne({
    email: ownerEmail,
  });

  const ownerId = owner
    ? String(owner._id)
    : "booknook-library";

  let added = 0;

  for (const [
    index,
    { source: _source, coverSource: _coverSource, ...record },
  ] of records.entries()) {
    const existing = await books.findOne(
      { seedKey: record.seedKey },
      { projection: { _id: 1 } },
    );

    if (existing) continue;

    const _id = new ObjectId();
    let completed = false;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const slug = await findAvailableBookSlug(
        books,
        record.title,
        _id,
      );

      try {
        const result = await books.updateOne(
          { seedKey: record.seedKey },
          {
            $setOnInsert: {
              ...record,
              _id,
              slug,
              availableCopies: record.totalCopies,
              ownerId,
              ownerName:
                owner?.name ||
                process.env.SEED_OWNER_NAME ||
                "BookNook Library",
              ownerEmail,
              createdAt: new Date(
                Date.now() - index * 86400000,
              ),
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        );

        added += result.upsertedCount;
        completed = true;
        break;
      } catch (error) {
        const slugConflict =
          error.code === 11000 &&
          (
            error.keyPattern?.slug ||
            error.message?.includes("unique_book_slug")
          );

        if (!slugConflict) throw error;
      }
    }

    if (!completed) {
      throw new Error(
        `Could not create a unique link for "${record.title}".`,
      );
    }
  }

  await ensureBookSlugs(db);

  const oldSeeds = await books
    .find(
      { seedKey: { $in: legacySeedKeys } },
      { projection: { _id: 1 } },
    )
    .toArray();

  let retired = 0;

  for (const old of oldSeeds) {
    const removed = await transaction(
      client,
      async (session) => {
        const book = await books.findOne(
          { _id: old._id },
          { session },
        );

        if (
          !book ||
          book.availableCopies !== book.totalCopies
        ) {
          return false;
        }

        const borrowed = await db
          .collection("borrows")
          .findOne(
            { bookId: old._id },
            { session },
          );

        if (borrowed) return false;

        const result = await books.deleteOne(
          {
            _id: old._id,
            seedKey: { $in: legacySeedKeys },
          },
          { session },
        );

        return result.deletedCount === 1;
      },
    );

    if (removed) retired += 1;
  }

  console.log(
    `${added} contemporary books added; ${records.length - added} existing current titles kept unchanged.`,
  );

  console.log(
    `${retired} old sample titles retired. ${oldSeeds.length - retired} retained until their borrowed copies are returned.`,
  );

  console.log(
    owner
      ? "New seed books belong to the existing reader account."
      : "New seed books belong to BookNook Library. Your own added books are unchanged.",
  );

  console.log("All books now have clean, unique URL slugs.");
} finally {
  await client.close();
}