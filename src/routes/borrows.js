import { Router } from "express";
import { transaction } from "../db.js";
import { HttpError } from "../middleware/error.js";
import { parseId } from "../utils/validation.js";

export function borrowRoutes({ db, client, authenticate }) {
  const router = Router();
  const borrows = db.collection("borrows");
  const books = db.collection("books");

  router.use(authenticate);

  router.post("/", async (req, res) => {
    const bookId = parseId(req.body?.bookId);

    const borrow = await transaction(client, async (session) => {
      const previous = await borrows.findOne(
        {
          bookId,
          userId: req.user.id,
        },
        { session },
      );

      if (previous) {
        throw new HttpError(
          409,
          "You already borrowed this book. Return your current copy first.",
        );
      }

      const book = await books.findOneAndUpdate(
        {
          _id: bookId,
          availableCopies: { $gt: 0 },
        },
        {
          $inc: { availableCopies: -1 },
        },
        {
          session,
          returnDocument: "after",
        },
      );

      if (!book) {
        const exists = await books.findOne(
          { _id: bookId },
          { session },
        );

        throw new HttpError(
          exists ? 409 : 404,
          exists
            ? "All copies are currently borrowed. Try another book for now."
            : "This book is no longer available.",
        );
      }

      const borrowDate = new Date();

      const data = {
        bookId,
        bookSlug: book.slug || null,
        bookTitle: book.title,
        bookImage: book.image,
        userId: req.user.id,
        userName: req.user.name,
        userEmail: req.user.email,
        borrowDate,
        returnDate: new Date(
          borrowDate.getTime() + 7 * 86400000,
        ),
      };

      const result = await borrows.insertOne(data, {
        session,
      });

      return {
        ...data,
        _id: result.insertedId,
      };
    });

    res.status(201).json({
      ...borrow,
      message: "Happy reading! Your book is borrowed for 7 days.",
    });
  });

  router.get("/", async (req, res) => {
    const items = await borrows
      .find({ userId: req.user.id })
      .sort({ borrowDate: -1 })
      .toArray();

    if (!items.length) {
      return res.json({ borrows: [] });
    }

    const bookRecords = await books
      .find(
        {
          _id: {
            $in: items.map((item) => item.bookId),
          },
        },
        {
          projection: {
            _id: 1,
            slug: 1,
          },
        },
      )
      .toArray();

    const bookSlugs = new Map(
      bookRecords.map((book) => [
        String(book._id),
        book.slug,
      ]),
    );

    res.json({
      borrows: items.map((item) => ({
        ...item,
        bookSlug:
          bookSlugs.get(String(item.bookId)) ||
          item.bookSlug ||
          null,
      })),
    });
  });

  router.delete("/:id", async (req, res) => {
    const _id = parseId(req.params.id);

    await transaction(client, async (session) => {
      const borrow = await borrows.findOne(
        { _id },
        { session },
      );

      if (!borrow) {
        throw new HttpError(
          404,
          "This borrow has already been returned.",
        );
      }

      if (borrow.userId !== req.user.id) {
        throw new HttpError(
          403,
          "You can only return your own borrowed books.",
        );
      }

      const result = await books.updateOne(
        { _id: borrow.bookId },
        {
          $inc: { availableCopies: 1 },
        },
        { session },
      );

      if (!result.matchedCount) {
        throw new HttpError(
          409,
          "The library record needs attention. Please contact the library before returning.",
        );
      }

      await borrows.deleteOne(
        {
          _id,
          userId: req.user.id,
        },
        { session },
      );
    });

    res.json({
      message: "Book returned. Thank you for sharing the next chapter.",
    });
  });

  return router;
}