const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const apiRoutes = require("./routes");
const errorHandler = require("./middleware/errorHandler");

const app = express();
app.set("trust proxy", 1); // behind Render / App Runner / ALB

// ---- Middleware ----
app.use(helmet());
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",").map((o) => o.trim());
app.use(cors({ origin: allowedOrigins.includes("*") ? true : allowedOrigins }));
app.use(express.json({ limit: "200kb" }));

// ---- Excel template download: /templates/shops_upload_template.xlsx ----
app.use("/templates", express.static(path.join(__dirname, "..", "templates")));

// ---- Health checks ----
app.get("/", (req, res) => res.json({ status: "ok", service: "shop-caller-backend", version: 2 }));
app.get("/health", (req, res) => res.json({ status: "healthy" }));

// ---- API ----
app.use("/api", apiRoutes);

// ---- 404 ----
app.use((req, res) => res.status(404).json({ success: false, message: "Route not found" }));

// ---- Central error handler (always last) ----
app.use(errorHandler);

module.exports = app;
