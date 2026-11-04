import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "./error.js";

export function createAuth(config, keyResolver) {
  const jwks =
    keyResolver ||
    createRemoteJWKSet(new URL(`${config.authUrl}/api/auth/jwks`));
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.split(" ").length !== 2) {
      return next(new HttpError(401, "Please log in to continue."));
    }
    try {
      const { payload } = await jwtVerify(header.slice(7), jwks, {
        issuer: config.authUrl,
        audience: config.audience,
        algorithms: ["EdDSA"],
        requiredClaims: ["sub", "exp", "iat", "email"],
      });
      if (
        typeof payload.sub !== "string" ||
        !payload.sub ||
        typeof payload.email !== "string" ||
        !payload.email.includes("@")
      ) {
        throw new Error("Invalid identity");
      }
      req.user = {
        id: payload.sub,
        email: payload.email.toLowerCase(),
        name:
          typeof payload.name === "string" ? payload.name : "BookNook reader",
      };
      next();
    } catch (error) {
      if (
        error instanceof TypeError ||
        error.code === "ERR_JWKS_TIMEOUT" ||
        error.code === "ECONNREFUSED"
      ) {
        return next(
          new HttpError(
            503,
            "The sign-in service is temporarily unavailable. Please try again.",
          ),
        );
      }
      next(
        new HttpError(401, "Your session has expired. Please log in again."),
      );
    }
  };
}
