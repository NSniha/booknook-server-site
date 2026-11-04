import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createAuth } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error.js";
import { bookRoutes } from "./routes/books.js";
import { borrowRoutes } from "./routes/borrows.js";

export function createApp({ db, client, config, keyResolver }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: config.clientOrigin,
      methods: ["GET", "POST", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 500,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        message: "Too many requests. Please take a short break and try again.",
      },
    }),
  );
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const authenticate = createAuth(config, keyResolver);
  const dependencies = { db, client, authenticate };
  app.use("/books", bookRoutes(dependencies));
  app.use("/borrows", borrowRoutes(dependencies));
  app.use((_req, res) =>
    res.status(404).json({ message: "This API route does not exist." }),
  );
  app.use(errorHandler);
  return app;
}
