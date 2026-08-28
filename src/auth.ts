import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { verifyActiveAdminSessionToken, type WifiAdminSession } from "./adminCredentialAuth.js";

declare global {
  namespace Express {
    interface Request {
      wifiAdminSession?: WifiAdminSession;
    }
  }
}

function requireToken(req: Request, res: Response, next: NextFunction, headerName: string, expectedToken: string, error: string) {
  const token = req.header(headerName);
  if (!token || token !== expectedToken) {
    return res.status(401).json({ error });
  }
  return next();
}

export function requireIntegrationToken(req: Request, res: Response, next: NextFunction) {
  return requireToken(
    req,
    res,
    next,
    "x-captyn-wifi-token",
    config.integrationToken,
    "Invalid CAPTYN Wi-Fi integration token"
  );
}

export async function requireAdminSession(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.header("x-captyn-wifi-admin-session") || req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const session = await verifyActiveAdminSessionToken(token);
    if (!session) {
      return res.status(401).json({ error: "Admin session expired" });
    }
    req.wifiAdminSession = session;
    return next();
  } catch (error) {
    return next(error);
  }
}
