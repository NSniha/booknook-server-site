import "dotenv/config";

export function getConfig(env = process.env) {
  for (const key of ["MONGODB_URI", "BETTER_AUTH_URL", "CLIENT_ORIGIN"]) {
    if (!env[key])
      throw new Error(
        `${key} is required. Copy .env.example to .env and configure it.`,
      );
  }
  return {
    port: Number(env.PORT || 5000),
    mongoUri: env.MONGODB_URI,
    dbName: env.MONGODB_DB || "booknook",
    clientOrigin: new URL(env.CLIENT_ORIGIN).origin,
    authUrl: env.BETTER_AUTH_URL.replace(/\/$/, ""),
    audience: env.JWT_AUDIENCE || "booknook-api",
  };
}
