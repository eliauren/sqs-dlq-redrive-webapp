import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import path from "path";
import { getEnvironment, registerDynamicEnvironments } from "./aws/envConfig";
import {
  listQueues,
  previewDlqMessages,
  redriveMessages,
} from "./aws/sqsService";
import { filterByAttributePath } from "./filtering/jsonFilter";
import { loadSsoProfiles } from "./aws/ssoProfiles";
import { startLogin, pollForLogin } from "./aws/ssoLogin";
import { discoverSsoEnvironments } from "./aws/ssoDiscovery";
import { getSsoSession } from "./aws/sessionStore";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Basic health endpoint
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// List SSO profiles discovered from ~/.aws/config
app.get("/api/sso-profiles", (_req, res) => {
  try {
    const profiles = loadSsoProfiles();
    res.json(profiles);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Rate limiter for SSO auth endpoints (prevent brute-force / abuse)
const ssoRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

// Start SSO device authorization flow for a given profile
app.post("/api/sso/login/start", ssoRateLimiter, async (req, res) => {
  const { profileName } = req.body ?? {};
  if (!profileName) {
    res.status(400).json({ error: "profileName is required" });
    return;
  }

  try {
    const result = await startLogin(profileName);
    res.json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Complete SSO login by exchanging device code for credentials
app.post("/api/sso/login/poll", ssoRateLimiter, async (req, res) => {
  const { profileName, deviceCode, sessionId } = req.body ?? {};
  if (!profileName || !deviceCode || !sessionId) {
    res.status(400).json({
      error: "profileName, deviceCode and sessionId are required",
    });
    return;
  }

  try {
    const result = await pollForLogin(profileName, deviceCode, sessionId);
    res.json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Return environments discovered via SSO ListAccounts / ListAccountRoles
app.get("/api/sso/environments", async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  try {
    const session = getSsoSession(sessionId);
    if (!session) {
      res.status(401).json({ error: "No active SSO session. Please connect first." });
      return;
    }

    const envs = await discoverSsoEnvironments(session);
    registerDynamicEnvironments(sessionId, envs);
    res.json(envs);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// List queues for an environment + region
app.get("/api/queues", async (req, res) => {
  const envId = req.query.envId as string;
  const region = req.query.region as string;
  const sessionId = req.query.sessionId as string | undefined;

  if (!envId || !region || !sessionId) {
    res.status(400).json({ error: "envId, region and sessionId are required" });
    return;
  }

  try {
    const env = getEnvironment(envId, sessionId);
    if (!env.regions.includes(region)) {
      res.status(400).json({ error: "Region not allowed for this environment" });
      return;
    }

    const queues = await listQueues(envId, region, sessionId);
    res.json({ queues });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Preview and filter DLQ messages
app.post("/api/preview", async (req, res) => {
  const { envId, region, dlqUrl, maxMessages, attributePath, expectedValue, excludeMatching } = req.body ?? {};
  const sessionId = req.body?.sessionId as string | undefined;

  if (!envId || !region || !dlqUrl || !sessionId) {
    res.status(400).json({
      error:
        "envId, region, dlqUrl and sessionId are required",
    });
    return;
  }

  try {
    const env = getEnvironment(envId, sessionId);
    if (!env.regions.includes(region)) {
      res.status(400).json({ error: "Region not allowed for this environment" });
      return;
    }

    const messages = await previewDlqMessages(
      envId,
      region,
      sessionId,
      dlqUrl,
      {
        maxMessages: maxMessages ?? 200,
      }
    );

    // Apply attribute filter only if attributePath is provided
    const useFilter = attributePath && expectedValue !== undefined;
    const filtered = useFilter
      ? filterByAttributePath(
          messages as any,
          attributePath,
          String(expectedValue),
          Boolean(excludeMatching)
        )
      : (messages as any).map((m: any) => ({
          raw: m,
          parsedBody: undefined,
          attributeValue: undefined,
        }));

    res.json({
      totalFetched: messages.length,
      totalMatched: filtered.length,
      messages: filtered.map((m: any) => ({
        messageId: m.raw.MessageId,
        receiptHandle: m.raw.ReceiptHandle,
        body: m.raw.Body,
        attributeValue: m.attributeValue,
        parseError: m.parseError,
      })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Redrive selected messages
app.post("/api/redrive", async (req, res) => {
  const {
    envId,
    region,
    dlqUrl,
    targetUrl,
    messages,
    deleteAfterSend,
  } = req.body ?? {};
  const sessionId = req.body?.sessionId as string | undefined;

  if (!envId || !region || !dlqUrl || !targetUrl || !Array.isArray(messages) || !sessionId) {
    res.status(400).json({
      error:
        "envId, region, dlqUrl, targetUrl, sessionId and messages[] are required",
    });
    return;
  }

  try {
    const env = getEnvironment(envId, sessionId);
    if (!env.regions.includes(region)) {
      res.status(400).json({ error: "Region not allowed for this environment" });
      return;
    }

    const summary = await redriveMessages(
      envId,
      region,
      sessionId,
      dlqUrl,
      targetUrl,
      messages,
      Boolean(deleteAfterSend)
    );

    res.json(summary);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Serve frontend from /public
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// Export the app for testing
export { app };

// Only start listening when run directly (not imported for tests)
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on port ${port}`);
  });
}

