import { Router } from "express";
import { ZodError } from "zod";
import { adminLoginSchema, authenticateCaptynAdmin, restoreCaptynAdminTrustedSession, trustedSessionSchema, verifyAdminSessionToken } from "../adminCredentialAuth.js";

export const adminAuthRouter = Router();

function errorPayload(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to sign in.";
  if (message === "TWO_FACTOR_REQUIRED") {
    return { status: 401, body: { error: "Enter your CAPTYN two-factor code.", code: "TWO_FACTOR_REQUIRED" } };
  }
  if (message === "ADMIN_MFA_SETUP_REQUIRED") {
    return { status: 403, body: { error: "Admin MFA setup is required before WiFi admin access.", code: "ADMIN_MFA_SETUP_REQUIRED" } };
  }
  if (
    message === "Invalid email or password" ||
    message === "Invalid two-factor code" ||
    message === "Access denied. Admin privileges required." ||
    message.includes("locked")
  ) {
    return { status: 401, body: { error: message } };
  }
  return { status: 403, body: { error: message } };
}

adminAuthRouter.post("/login", async (req, res, next) => {
  try {
    const credentials = adminLoginSchema.parse(req.body);
    const data = await authenticateCaptynAdmin(credentials);
    return res.json({ data });
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: "Email, password, and a valid code are required.", issues: error.issues });
    }
    const mapped = errorPayload(error);
    if (mapped.status >= 500) return next(error);
    return res.status(mapped.status).json(mapped.body);
  }
});

adminAuthRouter.post("/trusted-session", async (req, res, next) => {
  try {
    const input = trustedSessionSchema.parse(req.body);
    const data = await restoreCaptynAdminTrustedSession(input);
    return res.json({ data });
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: "Trusted device token is required.", issues: error.issues });
    }
    const mapped = errorPayload(error);
    if (mapped.status >= 500) return next(error);
    return res.status(mapped.status).json(mapped.body);
  }
});

adminAuthRouter.get("/session", (req, res) => {
  const token = req.header("x-captyn-wifi-admin-session") || req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const session = verifyAdminSessionToken(token);
  if (!session) return res.status(401).json({ error: "Admin session expired" });
  return res.json({ data: { user: { id: session.sub, email: session.email, name: session.name, role: session.role }, expiresAt: new Date(session.exp * 1000).toISOString() } });
});
