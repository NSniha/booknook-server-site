export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function errorHandler(error, _req, res, _next) {
  if (error.code === 11000) {
    return res
      .status(409)
      .json({
        message:
          "You already borrowed this book. Return your current copy first.",
      });
  }
  if (error.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({ message: "The request contains invalid JSON." });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ message: "The request is too large." });
  }
  const status = error.status || 500;
  if (status >= 500)
    console.error(`[BookNook API] ${error.name}: ${error.message}`);
  res.status(status).json({
    message:
      status >= 500
        ? "We could not complete this request. Please try again shortly."
        : error.message,
  });
}
