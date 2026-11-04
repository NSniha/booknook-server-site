import { ObjectId } from "mongodb";
import { HttpError } from "../middleware/error.js";

export const CATEGORIES = ["Fiction", "Science", "History", "Kids", "Others"];

export function parseId(value) {
  if (!/^[a-f\d]{24}$/i.test(value || ""))
    throw new HttpError(400, "This book or borrow ID is invalid.");
  return new ObjectId(value);
}

export function text(value, label, min, max) {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  ) {
    throw new HttpError(400, `${label} must contain ${min}–${max} characters.`);
  }
  return value.trim();
}

function imageUrl(value) {
  const image = text(value, "Book image", 8, 2048);
  try {
    const url = new URL(image);
    if (
      url.protocol !== "https:" ||
      !["i.ibb.co", "i.postimg.cc"].includes(url.hostname)
    )
      throw new Error();
  } catch {
    throw new HttpError(
      400,
      "Upload the book cover to imgbb or Postimages before saving.",
    );
  }
  return image;
}

export function validateBook(body, existing) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "Send the book details as a JSON object.");
  const title = text(body.title, "Book title", 2, 160);
  const author = text(body.author, "Author name", 2, 100);
  const description = text(body.description, "Description", 20, 3000);
  if (!CATEGORIES.includes(body.category))
    throw new HttpError(400, "Choose a valid book category.");
  if (
    !Number.isInteger(body.totalCopies) ||
    body.totalCopies < 1 ||
    body.totalCopies > 9999
  ) {
    throw new HttpError(
      400,
      "Total copies must be a whole number between 1 and 9999.",
    );
  }
  // Existing seed covers are local; newly supplied covers must be hosted uploads.
  const image =
    existing && body.image === existing.image
      ? existing.image
      : imageUrl(body.image);
  return {
    title,
    author,
    description,
    category: body.category,
    image,
    totalCopies: body.totalCopies,
  };
}

export function positiveInt(value, fallback, maximum = 10000) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new HttpError(400, "Invalid pagination value.");
  const parsed = Number(value);
  if (parsed < 1 || parsed > maximum)
    throw new HttpError(400, "Pagination value is outside the allowed range.");
  return parsed;
}

export function literalRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
