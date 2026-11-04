import dns from "node:dns/promises";
import { MongoClient } from "mongodb";

dns.setServers(["8.8.8.8", "1.1.1.1"]);

export async function connectDatabase(config) {
  const client = new MongoClient(config.mongoUri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  const db = client.db(config.dbName);
  const topology = await db.admin().command({ hello: 1 });
  if (!topology.setName && topology.msg !== "isdbgrid") {
    await client.close();
    throw new Error(
      "BookNook needs MongoDB Atlas or a replica set for atomic borrowing and returning.",
    );
  }
  await ensureIndexes(db);
  return { client, db };
}

export async function ensureIndexes(db) {
  await db.collection("books").createIndexes([
    { key: { createdAt: -1, _id: -1 }, name: "latest_books" },
    { key: { ownerId: 1, createdAt: -1 }, name: "books_by_owner" },
    { key: { category: 1, createdAt: -1 }, name: "books_by_category" },
  ]);
  await db.collection("borrows").createIndexes([
    {
      key: { bookId: 1, userId: 1 },
      unique: true,
      name: "one_active_borrow_per_reader",
    },
    { key: { userId: 1, borrowDate: -1 }, name: "reader_borrows" },
  ]);
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
