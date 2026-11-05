import dns from "node:dns/promises";
import { MongoClient } from "mongodb";
import { findAvailableBookSlug } from "./utils/book-slug.js";

dns.setServers(["8.8.8.8", "1.1.1.1"]);

export async function connectDatabase(config) {
  const client = new MongoClient(config.mongoUri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000,
  });

  try {
    await client.connect();

    const db = client.db(config.dbName);
    const topology = await db.admin().command({ hello: 1 });

    if (!topology.setName && topology.msg !== "isdbgrid") {
      throw new Error(
        "BookNook needs MongoDB Atlas or a replica set for atomic borrowing and returning.",
      );
    }

    await ensureIndexes(db);
    await ensureBookSlugs(db);

    return { client, db };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function ensureIndexes(db) {
  await db.collection("books").createIndexes([
    {
      key: { createdAt: -1, _id: -1 },
      name: "latest_books",
    },
    {
      key: { ownerId: 1, createdAt: -1 },
      name: "books_by_owner",
    },
    {
      key: { category: 1, createdAt: -1 },
      name: "books_by_category",
    },
    {
      key: { slug: 1 },
      unique: true,
      name: "unique_book_slug",
      partialFilterExpression: {
        slug: { $type: "string" },
      },
    },
  ]);

  await db.collection("borrows").createIndexes([
    {
      key: { bookId: 1, userId: 1 },
      unique: true,
      name: "one_active_borrow_per_reader",
    },
    {
      key: { userId: 1, borrowDate: -1 },
      name: "reader_borrows",
    },
  ]);
}

export async function ensureBookSlugs(db) {
  const books = db.collection("books");

  const missingSlug = {
    $or: [
      { slug: { $exists: false } },
      { slug: null },
      { slug: "" },
    ],
  };

  const cursor = books.find(missingSlug, {
    projection: {
      _id: 1,
      title: 1,
    },
  });

  try {
    for await (const book of cursor) {
      let saved = false;

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const slug = await findAvailableBookSlug(
          books,
          book.title,
          book._id,
        );

        try {
          await books.updateOne(
            {
              _id: book._id,
              ...missingSlug,
            },
            {
              $set: { slug },
            },
          );

          saved = true;
          break;
        } catch (error) {
          const slugConflict =
            error.code === 11000 &&
            (
              error.keyPattern?.slug ||
              error.message?.includes("unique_book_slug")
            );

          if (!slugConflict) {
            throw error;
          }
        }
      }

      if (!saved) {
        throw new Error(
          `Could not assign a unique slug to book ${book._id}.`,
        );
      }
    }
  } finally {
    await cursor.close();
  }
}

export async function transaction(client, task) {
  const session = client.startSession();

  try {
    return await session.withTransaction(() => task(session), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    });
  } finally {
    await session.endSession();
  }
}