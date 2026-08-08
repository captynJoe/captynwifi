import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import { ZodError } from "zod";
import { config } from "./config.js";
import { requireAdminSession, requireIntegrationToken } from "./auth.js";
import { integrationRouter } from "./routes/integration.js";
import { adminRouter } from "./routes/admin.js";
import { adminAuthRouter } from "./routes/adminAuth.js";
import { publicRouter } from "./routes/public.js";

const app = express();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "captyn-wifi-api",
    timestamp: new Date().toISOString()
  });
});

app.get(["/admin", "/admin/"], (_req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});
app.get(["/portal", "/portal/"], (_req, res) => {
  res.sendFile(path.join(publicDir, "portal.html"));
});
app.use("/admin", express.static(publicDir));
app.use("/portal", express.static(publicDir));
app.use("/api/public", publicRouter);
app.use("/api/admin-auth", adminAuthRouter);
app.use("/api/integrations", requireIntegrationToken, integrationRouter);
app.use("/api/admin", requireAdminSession, adminRouter);

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: "Invalid request",
      issues: error.issues
    });
  }

  console.error("CAPTYN Wi-Fi API error:", error);
  return res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  console.log(`CAPTYN Wi-Fi API running on port ${config.port}`);
});
