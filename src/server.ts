import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import multer from "multer";
import { ZodError } from "zod";
import { config } from "./config.js";
import { requireAdminSession, requireIntegrationToken } from "./auth.js";
import { integrationRouter } from "./routes/integration.js";
import { adminRouter } from "./routes/admin.js";
import { adminAuthRouter } from "./routes/adminAuth.js";
import { publicRouter, reconcilePendingMpesaPayments } from "./routes/public.js";
import { runLoyaltyCycle } from "./services/loyalty.js";
import { prisma } from "./prisma.js";

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
// /wifi/portal/ was a broken return address for a while (nginx maps /wifi/
// onto /portal/), so browsers still autocomplete it: send them to the portal.
app.get(/^\/portal\/portal(\/.*)?$/, (req, res) => {
  const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect(302, `/wifi/${query}`);
});
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

  // Thrown by multer's own upload.single() middleware, before any route
  // handler runs -- never reaches a route's own try/catch, so it has to be
  // handled centrally here.
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Image is too large -- please keep it under 8MB." });
  }

  console.error("CAPTYN Wi-Fi API error:", error);
  return res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  console.log(`CAPTYN Wi-Fi API running on port ${config.port}`);
});

setInterval(() => {
  reconcilePendingMpesaPayments()
    .then(({ activated, failed }) => {
      if (activated || failed) console.log(`M-PESA reconcile: activated ${activated}, failed ${failed}`);
    })
    .catch((error) => console.error("M-PESA reconcile error:", error));
}, 2 * 60 * 1000).unref();

// Weekly regulars reward: picks on Sundays, releases on the round's random day.
setInterval(() => {
  runLoyaltyCycle(prisma)
    .then(({ picked, released }) => {
      if (picked || released) console.log(`Loyalty: picked ${picked}, credited ${released}`);
    })
    .catch((error) => console.error("Loyalty cycle error:", error));
}, 10 * 60 * 1000).unref();
