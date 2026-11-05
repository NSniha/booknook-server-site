export function makeBookSlug(title) {
  const slug = String(title || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160)
    .replace(/-+$/g, "");

  return slug || "book";
}

export async function findAvailableBookSlug(books, title, bookId) {
  const base = makeBookSlug(title);
  let slug = base;
  let attempt = 0;

  while (true) {
    const existing = await books.findOne(
      { slug },
      { projection: { _id: 1 } },
    );

    if (!existing || String(existing._id) === String(bookId)) {
      return slug;
    }

    attempt += 1;

    slug =
      attempt === 1
        ? `${base}-${bookId}`
        : `${base}-${bookId}-${attempt}`;
  }
}