require("dotenv").config();
require("./config/env").validateEnv();

const Sentry = require("@sentry/node");
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "development",
  release: process.env.SENTRY_RELEASE || "unknown",
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,
  enabled: !!process.env.SENTRY_DSN,
  integrations: [Sentry.expressIntegration()],
});

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const logger = require("./config/logger");
const { requestIdMiddleware } = require("./middleware/requestId");
const { requestLogger } = require("./middleware/requestLogger");
const {
  normalizeErrorResponse,
  errorHandler,
} = require("./middleware/errorHandler");
const compressionMiddleware = require("./middleware/compression");
const {
  startLedgerMonitor,
  getLedgerStreamHealth,
} = require("./services/ledgerMonitor");
const {
  refreshActiveCampaignStatuses,
} = require("./services/campaignStatusService");
const {
  retryFailedContractDeployments,
} = require("./services/contractDeploymentRetryService");
const {
  sendWeeklyContributorDigests,
} = require("./services/weeklyDigestService");
const { upsertRecommendationsForUser } = require("./services/campaignRecommendationService");
const { flushQuietHours } = require("./services/notifications");
const { sendAlert } = require("./services/alerting");
const ff = require("./services/featureFlags");

const {
  assertNoLegacyPlaintextUserWalletSecrets,
} = require("./services/walletSecrets");
const {
  startRecurringContributionsCron,
} = require("./services/recurringContributionsService");
const {
  startSubscriptionClaimWorker,
} = require("./services/recurring");
const db = require("./config/database");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
const rateLimit = require("express-rate-limit");

const { csrfProtection } = require('./middleware/csrf');

const app = express();

const connectSrcDirectives = ["'self'"];
if (process.env.API_URL) connectSrcDirectives.push(process.env.API_URL);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: connectSrcDirectives,
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: { action: "deny" },
    noSniff: true,
  }),
);
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  }),
);
// Compress all responses >= COMPRESSION_THRESHOLD bytes (default 1 KB).
// SSE streams are excluded automatically. See middleware/compression.js.
app.use(compressionMiddleware);
app.post(
  "/api/webhooks/kyc",
  express.raw({ type: "application/json" }),
  require("./routes/kycWebhook"),
);
app.use(express.json({ limit: "50kb" }));
app.use(cookieParser());

// CSRF protection: validates X-CSRF-Token header on state-changing requests
// and ensures a CSRF cookie exists on all requests.
app.use(csrfProtection);
app.use(
  Sentry.sentryRequestMiddleware
    ? Sentry.sentryRequestMiddleware()
    : (req, res, next) => next(),
);
app.use(requestIdMiddleware);
app.use(requestLogger);

app.use(normalizeErrorResponse);

const isTest = process.env.NODE_ENV === "test";
const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 100000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (req) => {
    if (isTest) return true;
    const isPost = req.method === "POST";
    const p = req.path || "";
    if (!isPost) return false;
    return (
      p === "/auth/register" ||
      p === "/users/register" ||
      p === "/auth/login" ||
      p === "/users/login" ||
      p === "/contributions"
    );
  },
});
app.use("/api", globalApiLimiter);

const openApiSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "CrowdPay API",
      version: "1.0.0",
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "VALIDATION_ERROR" },
                message: { type: "string", example: "Invalid email format" },
                fields: {
                  type: "array",
                  nullable: true,
                  items: {
                    type: "object",
                    properties: {
                      field: { type: "string" },
                      message: { type: "string" },
                    },
                  },
                },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
    },
  },
  apis: ["./src/routes/*.js"],
});
app.get("/api/docs/openapi.json", (_req, res) => res.json(openApiSpec));
app.use(
  "/api/docs",
  swaggerUi.serveFiles(openApiSpec),
  swaggerUi.setup(openApiSpec),
);

const v1OpenApiSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "CrowdPay Public API",
      version: "1.0.0",
      description: "Versioned public API for third-party integrations",
    },
    servers: [{ url: "/api/v1" }, { url: "/v1" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "cp_live_…",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", example: "VALIDATION_ERROR" },
                message: { type: "string", example: "Invalid email format" },
                fields: {
                  type: "array",
                  nullable: true,
                  items: {
                    type: "object",
                    properties: {
                      field: { type: "string" },
                      message: { type: "string" },
                    },
                  },
                },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },
      },
    },
  },
  apis: ["./src/routes/v1.js"],
});

const v1Router = require("./routes/v1");
app.use("/api/v1", v1Router);
app.use("/v1", v1Router);
app.use("/api/v1/dev", require("./routes/dev"));
app.use("/v1/dev", require("./routes/dev"));
app.get("/api/v1/docs/openapi.json", (_req, res) => res.json(v1OpenApiSpec));
app.get("/v1/docs/openapi.json", (_req, res) => res.json(v1OpenApiSpec));
app.use(
  "/api/v1/docs",
  swaggerUi.serveFiles(v1OpenApiSpec),
  swaggerUi.setup(v1OpenApiSpec),
);
app.use(
  "/v1/docs",
  swaggerUi.serveFiles(v1OpenApiSpec),
  swaggerUi.setup(v1OpenApiSpec),
);

app.use("/api/auth", require("./routes/auth"));
app.use("/api/nft-rewards", require("./routes/nftRewards"));
// Backwards/alternate compatibility for docs + clients expecting /api/users/register|login.
app.use("/api/users", require("./routes/auth"));
// Session management routes
app.use("/api/auth", require("./routes/sessions"));
// Referral routes
app.use("/api/referrals", require("./routes/referrals"));
app.use("/api/users", require("./routes/users"));
app.use("/api", require("./routes/sponsorMatching"));
app.use("/api/invites", require("./routes/invites"));
app.use("/api", require("./routes/subscriptions"));
app.use("/api/campaigns", require("./routes/campaignUpdates"));
app.use("/api/campaigns", require("./routes/campaignComments"));
app.use("/api/campaigns", require("./routes/campaignFollowers"));
app.use("/api/campaigns", require("./routes/campaigns"));
app.use("/api/campaign-templates", require("./routes/campaignTemplates"));
app.use("/api/campaigns", require("./routes/impactReports"));
app.use("/api/campaigns", require("./routes/sponsorMatching"));
app.use("/api/campaigns", require("./routes/translations"));
app.use("/api/anchor", require("./routes/anchor"));
app.use("/api/contributions", require("./routes/contributions"));
app.use("/api/contribution-pools", require("./routes/contributionPools"));
app.use("/api/withdrawals", require("./routes/withdrawals"));
app.use("/api/stellar/transactions", require("./routes/stellarTransactions"));
app.use("/api/admin", require("./routes/admin"));
const apiKeysRouter = require("./routes/apiKeys");
app.use("/api/api-keys", apiKeysRouter);
app.use("/api/auth/api-keys", apiKeysRouter);
app.use("/api/webhooks", require("./routes/webhooks"));
app.use("/api/milestones", require("./routes/milestones"));
app.use("/api", require("./routes/disputes"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/emails", require("./routes/emails"));
app.use("/api/campaigns", require("./routes/thankYou"));
app.use("/api/contributions", require("./routes/thankYou"));
app.use("/api", require("./routes/announcement"));
app.use("/api/creator/analytics", require("./routes/creatorAnalytics"));
app.use("/api/governance", require("./routes/governance"));
app.use("/api/embed", require("./routes/embed"));
app.use("/embed", require("./routes/embed"));
app.use("/api/ops", require("./routes/ops"));

app.get("/health", async (_, res) => {
  try {
    await db.query('SELECT 1');
    const { total, idle, waiting, max, utilisation } = db.getPoolMetrics();

    if (utilisation > 90) {
      Sentry.withScope((scope) => {
        scope.setLevel('warning');
        scope.setTag('pool.utilisation', utilisation);
        scope.setContext('db.pool', { total, idle, waiting, max, utilisation });
        Sentry.captureMessage('Database pool utilisation exceeds 90%');
      });
    }

    res.json({
      status: "ok",
      db: {
        pool: { total, idle, waiting, max },
        utilisation,
      },
    });
  } catch (err) {
    res.status(503).json({ status: "error", error: err.message });
  }
});
app.get("/api/config", (_, res) => {
  const { USDC } = require("./config/stellar");
  res.json({
    platform_fee_bps: parseInt(process.env.PLATFORM_FEE_BPS || "0", 10),
    usdc_issuer:
      USDC.issuer ||
      process.env.USDC_ISSUER ||
      "GBBD472Q6TDQNCA24G2UG4M326T7J62TK2TYWNDSTXT5VBN2O4OXCT3U",
  });
});

// Public platform stats — used on the hero / landing section.
// Cached for 60 s; invalidated by ledgerMonitor after each indexed contribution.
const cache = require("./utils/cache");
const STATS_CACHE_KEY = "stats:public";
app.get("/api/stats", async (_req, res) => {
  const cached = cache.get(STATS_CACHE_KEY);
  if (cached) return res.json(cached);

  try {
    const db = require("./config/database");
    const [campaigns, raised, contributions] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total
                FROM campaigns
                WHERE deleted_at IS NULL AND status NOT IN ('draft', 'failed')`),
      db.query(`SELECT COALESCE(SUM(raised_amount), 0)::numeric AS total
                FROM campaigns
                WHERE deleted_at IS NULL`),
      db.query(`SELECT COUNT(*)::int AS total FROM contributions`),
    ]);

    const payload = {
      total_campaigns: campaigns.rows[0].total,
      total_raised: parseFloat(raised.rows[0].total),
      total_contributions: contributions.rows[0].total,
    };

    cache.set(STATS_CACHE_KEY, payload, 60_000); // 60 s TTL
    res.json(payload);
  } catch (err) {
    logger.error("Failed to fetch public stats", { error: err.message });
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

app.get("/health/ledger", async (_req, res) => {
  try {
    const body = await getLedgerStreamHealth();
    res.json(body);
  } catch (err) {
    res.status(500).json({ error: err.message || "ledger health failed" });
  }
});

if (ff.isEnabled("serve-frontend")) {
  const dist = path.join(__dirname, "../../frontend/dist");
  app.use(express.static(dist));
  app.get("*", async (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/health"))
      return next();

    const campaignMatch = req.path.match(/^\/campaigns\/([a-f0-9-]+)$/);
    if (campaignMatch) {
      try {
        const campaignId = campaignMatch[1];
        const { rows } = await db.query('SELECT title, description FROM campaigns WHERE id = $1', [campaignId]);
        if (rows.length > 0) {
          const campaign = rows[0];
          const fs = require("fs");
          let html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
          const title = (campaign.title || '').replace(/"/g, '&quot;');
          const desc = (campaign.description || '').replace(/"/g, '&quot;');
          const url = `${process.env.FRONTEND_URL || 'http://localhost:5173'}${req.path}`;
          const ogTags = `
            <meta property="og:title" content="${title}" />
            <meta property="og:description" content="${desc}" />
            <meta property="og:url" content="${url}" />
            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:title" content="${title}" />
            <meta name="twitter:description" content="${desc}" />
          `;
          html = html.replace('</head>', `${ogTags}</head>`);
          return res.send(html);
        }
      } catch (err) {
        // Fallback to sending standard index.html
      }
    }

    res.sendFile(path.join(dist, "index.html"));
  });
}

app.use(Sentry.expressErrorHandler());
app.use(errorHandler);

const { startWebhookRetryPoller } = require("./services/webhookDispatcher");

const PORT = process.env.PORT || 3001;

function startCampaignStatusCron() {
  if (!ff.isEnabled("campaign-status-cron")) return;
  const cron = require("node-cron");
  cron.schedule("0 * * * *", () => {
    refreshActiveCampaignStatuses().catch((err) => {
      logger.error("Campaign status cron failed", { error: err.message });
    });
  });
  logger.info("Campaign status cron scheduled (hourly)");
}

function startReconciliationCron() {
  if (!ff.isEnabled("reconciliation-cron")) return;
  const cron = require("node-cron");
  const { reconcileCampaignBalances } = require("./services/reconciliation");
  cron.schedule("*/15 * * * *", () => {
    reconcileCampaignBalances().catch((err) => {
      logger.error("Reconciliation cron failed", { error: err.message });
    });
  });
  logger.info("Reconciliation cron scheduled (every 15 minutes)");
}

function startWeeklyDigestCron() {
  if (!ff.isEnabled("weekly-digest-cron")) return;
  const cron = require("node-cron");
  const schedule = process.env.WEEKLY_DIGEST_CRON || "0 18 * * 0";
  cron.schedule(schedule, () => {
    sendWeeklyContributorDigests().catch((err) => {
      logger.error("Weekly digest cron failed", { error: err.message });
    });
  });
  logger.info("Weekly digest cron scheduled", { schedule });
}

function startScheduledPublishCron() {
  if (!ff.isEnabled("scheduled-publish-cron")) return;
  const cron = require("node-cron");
  const db = require("./config/database");
  const { publishDraftCampaign } = require("./services/campaignPublishing");
  cron.schedule("*/5 * * * *", async () => {
    try {
      const { rows } = await db.query(
        `SELECT id FROM campaigns
         WHERE status = 'draft' AND scheduled_publish_at IS NOT NULL AND scheduled_publish_at <= NOW()`
      );
      for (const row of rows) {
        try {
          await publishDraftCampaign(row.id);
        } catch (err) {
          logger.error("Scheduled publish failed for campaign", { campaign_id: row.id, error: err.message });
        }
      }
    } catch (err) {
      logger.error("Scheduled publish cron failed", { error: err.message });
    }
  });
  logger.info("Scheduled publish cron scheduled (every 5 minutes)");
}

function startNotificationDigestCron() {
  if (!ff.isEnabled("notification-quiet-hours-cron")) return;
  const cron = require("node-cron");
  const schedule = process.env.NOTIFICATION_DIGEST_CRON || "0 * * * *";
  cron.schedule(schedule, () => {
    flushQuietHours().catch((err) => {
      logger.error("Notification digest cron failed", { error: err.message });
    });
  });
  logger.info("Notification digest cron scheduled", { schedule });
}

function startFeeCacheRefreshCron() {
  const cron = require("node-cron");
  const { refreshFeeCache } = require("./services/feeRegistry");
  // Refresh every 5 minutes
  cron.schedule("*/5 * * * *", () => {
    refreshFeeCache().catch((err) => {
      logger.error("Fee cache refresh cron failed", { error: err.message });
    });
  });
  logger.info("Fee cache refresh cron scheduled (every 5 minutes)");
}

function startRecommendationRefreshCron() {
  const cron = require("node-cron");
  const schedule = process.env.RECOMMENDATION_REFRESH_CRON || "0 2 * * *";
  cron.schedule(schedule, async () => {
    try {
      const { rows } = await db.query(`SELECT id FROM users`);
      for (const row of rows) {
        await upsertRecommendationsForUser(row.id);
      }
    } catch (err) {
      logger.error("Recommendation refresh cron failed", { error: err.message });
    }
  });
  logger.info("Recommendation refresh cron scheduled", { schedule });
}

function startContractDeploymentRetryCron() {
  if (!ff.isEnabled("contract-deployment-retry-cron")) return;
  const cron = require("node-cron");
  cron.schedule("*/10 * * * *", () => {
    retryFailedContractDeployments().catch((err) => {
      logger.error("Contract deployment retry cron failed", { error: err.message });
    });
  });
  logger.info("Contract deployment retry cron scheduled (every 10 minutes)");
}
function startTrendingCron() {
  const cron = require("node-cron");
  const { recomputeTrendingScores } = require("./services/trendingService");
  cron.schedule("*/15 * * * *", () => {
    recomputeTrendingScores().catch((err) => {
      logger.error("Trending recompute cron failed", { error: err.message });
    });
  });
  logger.info("Trending recompute cron scheduled (every 15 minutes)");
}
function startBenchmarkRefreshCron() {
  const cron = require("node-cron");
  cron.schedule("0 3 * * *", () => {
    const { refreshPlatformBenchmarks } = require("./services/creatorAnalytics");
    refreshPlatformBenchmarks().catch((err) => {
      logger.error("Platform benchmarks refresh cron failed", { error: err.message });
    });
  });
  logger.info("Platform benchmarks refresh cron scheduled (daily at 3 AM)");
}

async function bootstrap() {
  if (process.env.NODE_ENV === "production") {
    await assertNoLegacyPlaintextUserWalletSecrets();
  }

  app.listen(PORT, () => {
    logger.info("CrowdPay backend running", {
      port: PORT,
      stellar_network: process.env.STELLAR_NETWORK,
    });
    startLedgerMonitor();
    startWebhookRetryPoller();
    startCampaignStatusCron();
    startReconciliationCron();
    startScheduledPublishCron();
    startWeeklyDigestCron();
    startNotificationDigestCron();
    startRecommendationRefreshCron();
    startContractDeploymentRetryCron();
    startRecurringContributionsCron();
    startSubscriptionClaimWorker();
    startBenchmarkRefreshCron();
    startFeeCacheRefreshCron();
    startTrendingCron();
    const { startHealthCollector } = require("./services/ops/healthCollector");
    startHealthCollector();
  });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error("Backend bootstrap failed", { error: err.message });
    sendAlert("Backend bootstrap failed", { error: err.message });
    process.exit(1);
  });
}

module.exports = app;
