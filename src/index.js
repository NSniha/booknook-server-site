import { getConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import { createApp } from "./app.js";

try {
  const config = getConfig();
  const { client, db } = await connectDatabase(config);
  const server = createApp({ db, client, config }).listen(
    config.port,
    "0.0.0.0",
    () => {
      console.log(`BookNook API is listening on port ${config.port}`);
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.close(async () => {
        await client.close();
        process.exit(0);
      });
    });
  }
} catch (error) {
  console.error(`BookNook could not start: ${error.message}`);
  process.exitCode = 1;
}
