import { Router } from "express";
import { ObjectId } from "mongodb";
import { transaction } from "../db.js";
import { HttpError } from "../middleware/error.js";
import { findAvailableBookSlug } from "../utils/book-slug.js";
import {
  CATEGORIES,
  literalRegex,
  parseId,
  positiveInt,
  validateBook,
} from "../utils/validation.js";

export function bookRoutes({ db, client, authenticate }) {
  const router = Router();
  const books = db.collection("books");

  router.get(
    "/",
    (req, res, next) => {
      if (req.query.mine !== undefined) {
        return authenticate(req, res, next);
      }

      next();
    },
    async (req, res) => {
      const filter = {};

      if (req.query.mine !== undefined) {
        if (req.query.mine !== "true") {
          throw new HttpError(400, "Invalid ownership filter.");
        }

        filter.ownerId = req.user.id;
      }

      if (req.query.category) {
        if (!CATEGORIES.includes(req.query.category)) {
          throw new HttpError(400, "Unknown book category.");
        }

        filter.category = req.query.category;
      }

      if (req.query.search) {
        if (
          typeof req.query.search !== "string" ||
          req.query.search.length > 120
        ) {
          throw new HttpError(400, "Search is too long.");
        }

        const pattern = {
          $regex: literalRegex(req.query.search.trim()),
          $options: "i",
        };

        filter.$or = [
          { title: pattern },
          { author: pattern },
        ];
      }

      if (req.query.available === "true") {
        filter.availableCopies = { $gt: 0 };
      }

      const sorts = {
        newest: { createdAt: -1, _id: -1 },
        oldest: { createdAt: 1, _id: 1 },
        title: { title: 1, _id: 1 },
      };

      const sortKey = req.query.sort || "newest";

      if (!Object.hasOwn(sorts, sortKey)) {
        throw new HttpError(400, "Unknown sort option.");
      }

      const page = positiveInt(req.query.page, 1);
      const limit = positiveInt(req.query.limit, 12, 100);

      const [items, total, counts] = await Promise.all([
        books
          .find(filter, { projection: { ownerEmail: 0 } })
          .sort(sorts[sortKey])
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),

        books.countDocuments(filter),

        books
          .aggregate([
            {
              $group: {
                _id: "$category",
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
      ]);

      res.json({
        books: items,
        total,
        page,
        pages: Math.ceil(total / limit),
        categories: Object.fromEntries(
          counts.map((category) => [
            category._id,
            category.count,
          ]),
        ),
      });
    },
  );

  router.get("/:id", authenticate, async (req, res) => {
    const identifier = req.params.id;

    if (
      identifier.length > 300 ||
      !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(identifier)
    ) {
      throw new HttpError(400, "Invalid book link.");
    }

    // Keep existing ID-based links working.
    let book = null;

    if (/^[a-f\d]{24}$/i.test(identifier)) {
      book = await books.findOne(
        { _id: parseId(identifier) },
        { projection: { ownerEmail: 0 } },
      );
    }

    // Also allow clean, slug-based links.
    if (!book) {
      book = await books.findOne(
        { slug: identifier },
        { projection: { ownerEmail: 0 } },
      );
    }

    if (!book) {
      throw new HttpError(
        404,
        "This book is no longer in the library.",
      );
    }

    const active = await db.collection("borrows").findOne({
      bookId: book._id,
      userId: req.user.id,
    });

    res.json({
      ...book,
      isBorrowed: Boolean(active),
    });
  });

  router.post("/", authenticate, async (req, res) => {
    const data = validateBook(req.body);
    const _id = new ObjectId();
    const now = new Date();

    let createdBook = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const slug = await findAvailableBookSlug(
        books,
        data.title,
        _id,
      );

      const book = {
        ...data,
        _id,
        slug,
        availableCopies: data.totalCopies,
        ownerId: req.user.id,
        ownerName: req.user.name,
        ownerEmail: req.user.email,
        createdAt: now,
        updatedAt: now,
      };

      try {
        await books.insertOne(book);
        createdBook = book;
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

    if (!createdBook) {
      throw new HttpError(
        409,
        "We couldn’t create a unique book link. Please try again.",
      );
    }

    res.status(201).json({
      ...createdBook,
      message: "Your book is now part of the library.",
    });
  });

  router.patch("/:id", authenticate, async (req, res) => {
    const _id = parseId(req.params.id);

    const result = await transaction(client, async (session) => {
      const current = await books.findOne(
        { _id },
        { session },
      );

      if (!current) {
        throw new HttpError(
          404,
          "This book could not be found.",
        );
      }

      if (current.ownerId !== req.user.id) {
        throw new HttpError(
          403,
          "You can only edit books you added.",
        );
      }

      const data = validateBook(req.body, current);

      const activeCopies =
        current.totalCopies - current.availableCopies;

      if (data.totalCopies < activeCopies) {
        throw new HttpError(
          409,
          `${activeCopies} copies are currently borrowed. Total copies cannot be lower than that.`,
        );
      }

      // Preserve the existing URL when a book's title changes.
      return books.findOneAndUpdate(
        {
          _id,
          ownerId: req.user.id,
        },
        {
          $set: {
            ...data,
            slug: current.slug,
            updatedAt: new Date(),
          },
          $inc: {
            availableCopies:
              data.totalCopies - current.totalCopies,
          },
        },
        {
          session,
          returnDocument: "after",
        },
      );
    });

    res.json({
      ...result,
      message: "Your book has been updated.",
    });
  });

  router.delete("/:id", authenticate, async (req, res) => {
    const _id = parseId(req.params.id);

    await transaction(client, async (session) => {
      const book = await books.findOne(
        { _id },
        { session },
      );

      if (!book) {
        throw new HttpError(
          404,
          "This book has already been removed.",
        );
      }

      if (book.ownerId !== req.user.id) {
        throw new HttpError(
          403,
          "You can only delete books you added.",
        );
      }

      if (book.availableCopies !== book.totalCopies) {
        throw new HttpError(
          409,
          "This book has borrowed copies. Wait for all copies to be returned before deleting it.",
        );
      }

      await books.deleteOne(
        {
          _id,
          ownerId: req.user.id,
        },
        { session },
      );
    });

    res.json({
      message: "The book has been removed from the library.",
    });
  });

  return router;
}