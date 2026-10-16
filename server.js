import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3333);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_ENDPOINT = "/select-ticket-between-start-and-end-dates.html/v.2.0";
const DEFAULT_PERFORMANCE_ENDPOINT = "/ms/dashboard/performance-dashboard";
const CACHE_TTL_MS = Number(process.env.KAPTURE_CACHE_TTL_MS || 5 * 60_000);
const COMPLETED_STALE_TTL_MS = Number(process.env.KAPTURE_COMPLETED_STALE_TTL_MS || 60 * 60_000);
const STATUS_STALE_TTL_MS = Number(process.env.KAPTURE_STATUS_STALE_TTL_MS || 30 * 60_000);
const ACTIVITY_LOOKBACK_DAYS = clampNumber(Number(process.env.KAPTURE_ACTIVITY_LOOKBACK_DAYS || 60), 0, 180);
const COMPLETED_LOOKBACK_DAYS = clampNumber(Number(process.env.KAPTURE_COMPLETED_LOOKBACK_DAYS || ACTIVITY_LOOKBACK_DAYS), 0, 365);
const FAST_COMPLETED_LOOKBACK_DAYS = clampNumber(Number(process.env.KAPTURE_FAST_COMPLETED_LOOKBACK_DAYS || 21), 0, 90);
const REQUEST_TIMEOUT_MS = clampNumber(Number(process.env.KAPTURE_REQUEST_TIMEOUT_MS || 20_000), 2_000, 120_000);
const PERFORMANCE_TIMEOUT_MS = clampNumber(Number(process.env.KAPTURE_PERFORMANCE_TIMEOUT_MS || 5_000), 1_000, 30_000);
const CREATED_SUPPLEMENT_TIMEOUT_MS = clampNumber(Number(process.env.KAPTURE_CREATED_SUPPLEMENT_TIMEOUT_MS || 12_000), 2_000, 60_000);
const CREATED_SUPPLEMENT_MAX_PAGES = clampNumber(Number(process.env.KAPTURE_CREATED_SUPPLEMENT_MAX_PAGES || 10), 1, 100);
// Kapture starts truncating pages above ~4 parallel reads (measured: 8 and 12 both
// returned 3,588 completed tickets where 1 and 4 returned 4,730). Keep this at 4;
// fetchKaptureStatusTicketsOnce repairs any truncation it still sees, but repairs
// cost sequential round-trips and are slower than just not overloading the API.
const PAGE_CONCURRENCY = clampNumber(Number(process.env.KAPTURE_PAGE_CONCURRENCY || 4), 1, 12);
const CACHE_SCHEMA_VERSION = "2026-08-18-resolved-refresh-v1";
const STATUS_CACHE_DIR = path.join(__dirname, "logs", "status-cache");
const cache = new Map();
const statusCache = new Map();
const performanceCache = new Map();

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      return sendJson(res, getHealth());
    }

    if (url.pathname === "/api/tickets") {
      const result = await getDashboardData(url.searchParams, { detailMode: "fast" });
      return sendJson(res, result);
    }

    if (url.pathname === "/api/export/daily.csv") {
      const result = await getDashboardData(url.searchParams);
      return sendCsv(res, "daily_ticket_summary.csv", dailyRowsToCsv(result.daily));
    }

    if (url.pathname === "/api/export/created.csv") {
      const result = await getDashboardData(url.searchParams);
      return sendCsv(res, "created_tickets.csv", createdRowsToCsv(result.createdTickets));
    }

    if (url.pathname === "/api/export/pending.csv") {
      const result = await getDashboardData(url.searchParams);
      return sendCsv(res, "pending_tickets.csv", pendingRowsToCsv(result.pendingTickets));
    }

    if (url.pathname === "/api/export/resolved.csv" || url.pathname === "/api/export/completed.csv") {
      const result = await getDashboardData(url.searchParams, { detailMode: "full" });
      return sendCsv(res, "resolved_tickets.csv", completedRowsToCsv(result.completedTickets));
    }

    if (url.pathname === "/api/export/team.csv") {
      const result = await getDashboardData(url.searchParams);
      return sendCsv(res, "teammate_daily_ticket_summary.csv", teammateRowsToCsv(result.teammateDaily));
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    const status = Number(error.statusCode || error.status || 500);
    sendJson(res, { error: sanitizeError(error) }, status);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Kapture dashboard running at http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  console.error(`Kapture dashboard failed to start: ${sanitizeError(error)}`);
  process.exitCode = 1;
});

process.on("unhandledRejection", (error) => {
  console.error(`Unhandled dashboard error: ${sanitizeError(error)}`);
});

process.on("uncaughtException", (error) => {
  console.error(`Fatal dashboard error: ${sanitizeError(error)}`);
  process.exit(1);
});

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function serveStatic(requestPath, res) {
  const normalizedPath = requestPath === "/" ? "/dashboard.html" : requestPath;
  const safePath = path.normalize(decodeURIComponent(normalizedPath))
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const absolutePath = path.join(__dirname, safePath);

  if (!absolutePath.startsWith(__dirname)) {
    return sendText(res, "Not found", 404);
  }

  try {
    const body = await readFile(absolutePath);
    const contentType = MIME_TYPES.get(path.extname(absolutePath)) || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    sendText(res, "Not found", 404);
  }
}

function getHealth() {
  return {
    ok: Boolean(process.env.KAPTURE_BASE_URL && process.env.KAPTURE_LIST_AUTH_TOKEN),
    port: PORT,
    hasBaseUrl: Boolean(process.env.KAPTURE_BASE_URL),
    hasToken: Boolean(process.env.KAPTURE_LIST_AUTH_TOKEN),
    endpoint: process.env.KAPTURE_TICKET_LIST_ENDPOINT || DEFAULT_ENDPOINT,
  };
}

async function getDashboardData(searchParams, options = {}) {
  const range = getDateRange(searchParams);
  const detailMode = options.detailMode || cleanFilter(searchParams.get("detailMode")) || "fast";
  const forceRefresh = options.forceRefresh || searchParams.get("refresh") === "1";
  const fetchRange = getActivityFetchRange(range, detailMode);
  const filters = getFilters(searchParams);
  const [tickets, performanceResult] = await Promise.all([
    fetchTickets(fetchRange, { forceRefresh }),
    fetchPerformanceTotals(range).then((totals) => ({ totals, error: "" })).catch((error) => {
      console.warn(`Performance totals unavailable: ${sanitizeError(error)}`);
      return { totals: null, error: sanitizeError(error) };
    }),
  ]);
  const performanceTotals = performanceResult.totals;
  const filteredTickets = applyFilters(tickets, filters);
  const summary = summarizeTickets(filteredTickets, range);
  applyPerformanceTotals(summary, performanceTotals, range);
  const metricDiagnostics = buildMetricDiagnostics(summary, performanceTotals, performanceResult.error);

  return {
    fetchedAt: new Date().toISOString(),
    range,
    fetchRange,
    detailMode,
    filters,
    rawCount: tickets.length,
    filteredCount: filteredTickets.length,
    fetchStatusCounts: countBy(tickets, "__fetchStatus"),
    rawResolvedDateCounts: countResolvedDates(tickets),
    forceRefresh,
    ...summary,
    metricDiagnostics,
  };
}

function getDateRange(searchParams) {
  const startDate = normalizeDateKey(searchParams.get("startDate"));
  const endDate = normalizeDateKey(searchParams.get("endDate"));

  if (!startDate || !endDate) {
    const error = new Error("Select both startDate and endDate.");
    error.statusCode = 400;
    throw error;
  }

  if (startDate > endDate) {
    const error = new Error("Start date must be before or equal to end date.");
    error.statusCode = 400;
    throw error;
  }

  return { startDate, endDate, days: daysBetween(startDate, endDate) + 1 };
}

function getActivityFetchRange(range, detailMode = "fast") {
  const pendingLookbackDays = getActivityLookbackDays(range);
  const completedLookbackDays = getCompletedLookbackDays(range, detailMode);
  const startDate = addDays(range.startDate, -pendingLookbackDays);
  const completedStartDate = addDays(range.startDate, -completedLookbackDays);
  const today = toDateKey(new Date());
  const bufferedEndDate = addDays(range.endDate, 1);
  const endDate = bufferedEndDate > today ? range.endDate : bufferedEndDate;
  return {
    startDate,
    endDate,
    days: daysBetween(startDate, endDate) + 1,
    createdStartDate: range.startDate,
    createdEndDate: range.endDate,
    completedStartDate,
    completedDays: daysBetween(completedStartDate, endDate) + 1,
  };
}

function getActivityLookbackDays(range) {
  if (range.days <= 2) return 0;
  if (range.days <= 7) return Math.min(ACTIVITY_LOOKBACK_DAYS, 7);
  return Math.min(ACTIVITY_LOOKBACK_DAYS, 30);
}

function getCompletedLookbackDays(range, detailMode = "fast") {
  if (detailMode !== "full") {
    return Math.min(FAST_COMPLETED_LOOKBACK_DAYS, COMPLETED_LOOKBACK_DAYS);
  }
  if (range.days <= 2) return COMPLETED_LOOKBACK_DAYS;
  if (range.days <= 7) return Math.max(COMPLETED_LOOKBACK_DAYS, 14);
  return Math.max(COMPLETED_LOOKBACK_DAYS, 30);
}

function getFilters(searchParams) {
  return {
    queueName: cleanFilter(searchParams.get("queueName")),
    creatorName: cleanFilter(searchParams.get("creatorName")),
    titlePrefix: cleanFilter(searchParams.get("titlePrefix")),
    titleContains: cleanFilter(searchParams.get("titleContains")),
  };
}

function cleanFilter(value) {
  return String(value || "").trim();
}

async function fetchTickets(range, options = {}) {
  const config = getKaptureConfig();
  const cacheKey = JSON.stringify({
    version: CACHE_SCHEMA_VERSION,
    range,
    baseUrl: config.baseUrl,
    endpoint: config.endpoint,
    method: config.method,
    payloadStyle: config.payloadStyle,
    statuses: config.fetchStatuses,
    createdStatus: config.createdStatus,
    createdStartDate: range.createdStartDate,
    createdEndDate: range.createdEndDate,
    pageLimit: config.pageLimit,
    startParam: process.env.KAPTURE_START_DATE_PARAM,
    endParam: process.env.KAPTURE_END_DATE_PARAM,
    dateValueMode: config.dateValueMode,
  });

  const cached = cache.get(cacheKey);
  if (!options.forceRefresh && cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return cached.tickets;
  }

  if (config.payloadStyle === "kapture-array") {
    const tickets = await fetchKaptureArrayTickets(config, range, options);
    cache.set(cacheKey, { createdAt: Date.now(), tickets });
    return tickets;
  }

  const attempts = buildRequestAttempts(config, range);
  let lastError;

  for (const attempt of attempts) {
    try {
      const payload = await callKapture(config, attempt);
      const tickets = extractTickets(payload);
      cache.set(cacheKey, { createdAt: Date.now(), tickets });
      return tickets;
    } catch (error) {
      lastError = error;
      if (error.statusCode && error.statusCode < 500 && error.statusCode !== 400 && error.statusCode !== 415) {
        break;
      }
    }
  }

  throw lastError || new Error("Unable to fetch Kapture tickets.");
}

function getKaptureConfig() {
  const baseUrl = process.env.KAPTURE_BASE_URL;
  const token = process.env.KAPTURE_LIST_AUTH_TOKEN;

  if (!baseUrl || !token) {
    const missing = [
      !baseUrl && "KAPTURE_BASE_URL",
      !token && "KAPTURE_LIST_AUTH_TOKEN",
    ].filter(Boolean);
    const error = new Error(`Missing required live data env var${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
    error.statusCode = 503;
    throw error;
  }

  return {
    baseUrl,
    token,
    endpoint: process.env.KAPTURE_TICKET_LIST_ENDPOINT || DEFAULT_ENDPOINT,
    performanceEndpoint: process.env.KAPTURE_PERFORMANCE_DASHBOARD_ENDPOINT || DEFAULT_PERFORMANCE_ENDPOINT,
    performanceTotalsEnabled: process.env.KAPTURE_PERFORMANCE_TOTALS !== "0",
    performanceAgentIds: process.env.KAPTURE_DASHBOARD_AGENT_IDS || "",
    performanceCookie: process.env.KAPTURE_DASHBOARD_COOKIE || process.env.KAPTURE_COOKIE || "",
    performanceWidgetId: process.env.KAPTURE_DASHBOARD_WIDGET_ID || "1002185",
    method: String(process.env.KAPTURE_HTTP_METHOD || "POST").toUpperCase(),
    authHeader: process.env.KAPTURE_AUTH_HEADER || "Authorization",
    authPrefix: process.env.KAPTURE_AUTH_PREFIX || "",
    dateValueMode: process.env.KAPTURE_DATE_VALUE_MODE || "date",
    payloadStyle: process.env.KAPTURE_PAYLOAD_STYLE || "kapture-array",
    fetchStatuses: parseFetchStatuses(process.env.KAPTURE_FETCH_STATUSES || "P,C"),
    createdStatus: process.env.KAPTURE_CREATED_STATUS ?? "",
    pageLimit: clampNumber(Number(process.env.KAPTURE_PAGE_LIMIT || 500), 1, 2000),
    maxPages: clampNumber(Number(process.env.KAPTURE_MAX_PAGES || 100), 1, 1000),
    pageConcurrency: PAGE_CONCURRENCY,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    performanceTimeoutMs: PERFORMANCE_TIMEOUT_MS,
    createdSupplementTimeoutMs: CREATED_SUPPLEMENT_TIMEOUT_MS,
    createdSupplementMaxPages: CREATED_SUPPLEMENT_MAX_PAGES,
    cookie: process.env.KAPTURE_COOKIE || "",
    extraHeaders: parseExtraHeaders(),
  };
}

async function fetchPerformanceTotals(range) {
  const config = getKaptureConfig();
  if (!config.performanceTotalsEnabled) return null;
  if (!config.performanceCookie) return null;

  const cacheKey = JSON.stringify({
    endpoint: config.performanceEndpoint,
    startDate: range.startDate,
    endDate: range.endDate,
    agentIds: config.performanceAgentIds,
  });
  const cached = performanceCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return cached.totals;
  }

  const [created, resolved] = await Promise.all([
    fetchPerformanceMetric(config, range, "TOTAL_TICKETS_CREATED", "Total Tickets Created", 2),
    fetchPerformanceMetric(config, range, "TOTAL_TICKETS_RESOLVED", "Total Tickets Resolved", 3),
  ]);
  const totals = { created, resolved };
  performanceCache.set(cacheKey, { createdAt: Date.now(), totals });
  return totals;
}

async function fetchPerformanceMetric(config, range, key, displayName, id) {
  const { startDate, endDate } = dateRangeToEpochMillis(range);
  const endpointUrl = resolveEndpoint(config.baseUrl, config.performanceEndpoint);
  const filter = {
    startDate,
    endDate,
    employeeGroups: [],
  };
  if (config.performanceAgentIds) {
    filter.agentIds = config.performanceAgentIds;
  }

  const body = {
    grid_layout: {
      w: 6,
      h: 3,
      x: 0,
      y: 1,
      i: config.performanceWidgetId,
    },
    widge_type: "piechart",
    level: "",
    filter,
    keyToFieldList: {
      AgentTicketDetails: [
        {
          key,
          id,
          displayName,
          type: "AgentTicketDetails",
          fieldDetail: null,
          parentkey: null,
          onhover: null,
          fieldType: "",
          dateFormat: null,
          fieldLogic: null,
          category: null,
          dashboardCategory: null,
          customField: null,
          isCustomField: null,
        },
      ],
    },
    customConfiguration: {},
  };

  const payload = await callJsonEndpoint(config, endpointUrl, {
    body: JSON.stringify(body),
    timeoutMs: config.performanceTimeoutMs,
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Cookie: config.performanceCookie,
      Origin: config.baseUrl,
      Referer: `${config.baseUrl}/nui/dashboard/custom/894`,
      "X-KapTrace-ID": `${randomUUID()}###${firstAgentId(config.performanceAgentIds)}`,
    },
  });

  return extractPerformanceMetric(payload, key, displayName);
}

async function callJsonEndpoint(config, endpointUrl, attempt) {
  const controller = new AbortController();
  const timeout = Number(attempt.timeoutMs || config.requestTimeoutMs || REQUEST_TIMEOUT_MS);
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  let response;
  let text;

  try {
    response = await fetch(endpointUrl, {
      method: "POST",
      headers: attempt.headers,
      body: attempt.body,
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Kapture dashboard API timed out after ${Math.round(timeout / 1000)} seconds.`);
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const payload = parseResponseBody(text);
  if (!response.ok) {
    const message = extractErrorMessage(payload) || text || response.statusText;
    const error = new Error(`Kapture dashboard API returned ${response.status}: ${message.slice(0, 500)}`);
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

function dateRangeToEpochMillis(range) {
  return {
    startDate: Date.parse(`${range.startDate}T00:00:00.000+05:30`),
    endDate: Date.parse(`${range.endDate}T23:59:59.999+05:30`),
  };
}

function firstAgentId(agentIds) {
  return String(agentIds || "").split(",").map((value) => value.trim()).find(Boolean) || "";
}

function extractPerformanceMetric(payload, key, displayName) {
  const direct = findMetricValue(payload, key, displayName);
  return Number.isFinite(direct) ? direct : null;
}

function findMetricValue(value, key, displayName) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMetricValue(item, key, displayName);
      if (Number.isFinite(found)) return found;
    }
    return null;
  }

  const entries = Object.entries(value);
  for (const [entryKey, entryValue] of entries) {
    if (entryKey.toLowerCase() === key.toLowerCase()) {
      const numeric = numericValue(entryValue);
      if (Number.isFinite(numeric)) return numeric;
    }
  }

  const itemKey = String(value.key || value.fieldKey || value.name || value.displayName || "").trim();
  if ([key, displayName].some((candidate) => candidate && itemKey.toLowerCase() === candidate.toLowerCase())) {
    for (const prop of ["value", "count", "total", "totalCount", "metricValue", "data", "result", "y"]) {
      const numeric = numericValue(value[prop]);
      if (Number.isFinite(numeric)) return numeric;
    }
  }

  for (const prop of ["value", "count", "total", "totalCount", "metricValue", "data", "result", "y"]) {
    const nested = value[prop];
    if (nested && typeof nested === "object") {
      const found = findMetricValue(nested, key, displayName);
      if (Number.isFinite(found)) return found;
    }
  }

  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = findMetricValue(child, key, displayName);
    if (Number.isFinite(found)) return found;
  }

  return null;
}

function numericValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (Array.isArray(value) || (value && typeof value === "object")) return findFirstLikelyNumber(value);
  return null;
}

function findFirstLikelyNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstLikelyNumber(item);
      if (Number.isFinite(found)) return found;
    }
    return null;
  }
  for (const key of ["value", "count", "total", "totalCount", "metricValue", "data", "result", "y"]) {
    const found = numericValue(value[key]);
    if (Number.isFinite(found)) return found;
  }
  return null;
}

function parseFetchStatuses(raw) {
  const statuses = String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return statuses.length ? statuses : [""];
}

function parseExtraHeaders() {
  const raw = process.env.KAPTURE_EXTRA_HEADERS;
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildRequestAttempts(config, range) {
  const explicitStart = process.env.KAPTURE_START_DATE_PARAM;
  const explicitEnd = process.env.KAPTURE_END_DATE_PARAM;
  const startValue = formatApiDate(range.startDate, "start", config.dateValueMode);
  const endValue = formatApiDate(range.endDate, "end", config.dateValueMode);

  if (explicitStart && explicitEnd) {
    return [buildAttempt(config, explicitStart, explicitEnd, startValue, endValue, "json")];
  }

  return [
    buildAttempt(config, "startDate", "endDate", startValue, endValue, "json"),
    buildAttempt(config, "start_date", "end_date", startValue, endValue, "json"),
    buildAttempt(config, "fromDate", "toDate", startValue, endValue, "json"),
    buildAttempt(config, "startDate", "endDate", startValue, endValue, "form"),
    buildAttempt(config, "start_date", "end_date", startValue, endValue, "form"),
  ];
}

async function fetchKaptureArrayTickets(config, range, options = {}) {
  const completedStatuses = orderedFetchStatuses(config.fetchStatuses).filter(isCompletedStatusParam);
  const activeStatuses = orderedFetchStatuses(config.fetchStatuses).filter((status) => !isCompletedStatusParam(status));
  const ticketGroups = [];

  for (const status of completedStatuses) {
    ticketGroups.push(await fetchKaptureStatusTickets(config, range, status, options));
  }

  const activeTicketGroups = await Promise.all(
    activeStatuses.map((status) => fetchKaptureStatusTickets(config, range, status, options)),
  );
  ticketGroups.push(...activeTicketGroups);

  if (shouldFetchCreatedStatus(config)) {
    const createdTickets = await fetchCreatedStatusTickets(config, getCreatedStatusFetchRange(range), options);
    ticketGroups.push(createdTickets.map((ticket) => ({ ...ticket, __createdOnly: true })));
  }

  const allTickets = [];
  const ticketIndexes = new Map();

  for (const tickets of ticketGroups) {
    for (const ticket of tickets) {
      addTicketVersion(allTickets, ticketIndexes, ticket);
    }
  }

  return allTickets;
}

async function fetchCreatedStatusTickets(config, range, options = {}) {
  const supplementConfig = {
    ...config,
    maxPages: config.createdSupplementMaxPages,
    requestTimeoutMs: Math.min(config.requestTimeoutMs, config.createdSupplementTimeoutMs),
  };

  try {
    return await withTimeout(
      fetchKaptureStatusTickets(supplementConfig, range, config.createdStatus, options),
      config.createdSupplementTimeoutMs,
      "Created-ticket supplement timed out.",
    );
  } catch (error) {
    console.warn(`Created-ticket supplement failed: ${sanitizeError(error)}`);
    return [];
  }
}

function shouldFetchCreatedStatus(config) {
  return !config.fetchStatuses.some((status) => String(status) === String(config.createdStatus));
}

function getCreatedStatusFetchRange(range) {
  const startDate = range.createdStartDate || range.startDate;
  const endDate = range.createdEndDate || range.endDate;
  return {
    ...range,
    startDate,
    endDate,
    days: daysBetween(startDate, endDate) + 1,
  };
}

function orderedFetchStatuses(statuses) {
  return [...statuses].sort((a, b) => Number(!isCompletedStatusParam(a)) - Number(!isCompletedStatusParam(b)));
}

async function fetchKaptureStatusTickets(config, range, status, options = {}) {
  const statusRange = getStatusFetchRange(range, status);
  const cacheKey = getStatusCacheKey(config, statusRange, status);
  const cached = statusCache.get(cacheKey);

  // An empty hit is never served from cache: Kapture returns an empty completed
  // set intermittently, and memoizing that zero blanks out every resolution for
  // the whole TTL. Every other cache read below already guards on .length.
  if (!options.forceRefresh && cached && cached.tickets.length && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return cached.tickets;
  }

  const completedStatus = isCompletedStatusParam(status);
  const maxAttempts = completedStatus ? 3 : 1;
  let tickets = [];

  try {
    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      tickets = await fetchKaptureStatusTicketsOnce(config, statusRange, status);
      if (tickets.length || !completedStatus) break;
      await sleep(700 + attemptIndex * 1_000);
    }
  } catch (error) {
    const fallback = await readStatusCache(cacheKey);
    if (!options.forceRefresh && fallback && fallback.tickets.length && Date.now() - fallback.createdAt < STATUS_STALE_TTL_MS) {
      statusCache.set(cacheKey, fallback);
      return fallback.tickets;
    }
    throw error;
  }

  if (tickets.length) {
    statusCache.set(cacheKey, { createdAt: Date.now(), tickets });
    await writeStatusCache(cacheKey, tickets);
    return tickets;
  }

  if (!options.forceRefresh && completedStatus && cached && cached.tickets.length && Date.now() - cached.createdAt < COMPLETED_STALE_TTL_MS) {
    return cached.tickets;
  }

  if (!options.forceRefresh && completedStatus) {
    const diskCached = await readStatusCache(cacheKey);
    if (diskCached && diskCached.tickets.length && Date.now() - diskCached.createdAt < COMPLETED_STALE_TTL_MS) {
      statusCache.set(cacheKey, diskCached);
      return diskCached.tickets;
    }
  }

  // Deliberately not cached: an empty result here means every retry and both
  // cache tiers came up short, which is far more likely to be a flaky upstream
  // than a genuinely empty range. Storing it would serve 0 until the TTL ran out.
  return tickets;
}

// Walks every page of one status. Kapture returns short-but-non-empty pages in the
// middle of a result set, so a short page must NOT be treated as the end: stopping
// there discards every later page (measured: ~23% of completed tickets lost, and the
// current day dropped to zero). Only a page that comes back genuinely empty proves
// we are past the end. Re-reading an offset is harmless — addTicketVersion dedupes
// by ticketId. Width adapts so small result sets still cost two requests.
async function fetchKaptureStatusTicketsOnce(config, range, status) {
  const tickets = [];
  let pageIndex = 0;
  let previousPageFull = false;
  let repairedPages = 0;

  while (pageIndex < config.maxPages) {
    const width = previousPageFull ? config.pageConcurrency : 1;
    const batchIndexes = [];
    for (
      let batchIndex = pageIndex;
      batchIndex < Math.min(pageIndex + width, config.maxPages);
      batchIndex += 1
    ) {
      batchIndexes.push(batchIndex);
    }

    const batchPages = await Promise.all(
      batchIndexes.map((batchIndex) => fetchKaptureTicketPage(config, range, status, batchIndex)),
    );

    // Kapture truncates pages under parallel load, and the response carries no total
    // to check against, so any short page read inside a batch is untrustworthy. Read
    // those offsets again one at a time and keep whichever read returned more rows.
    if (batchIndexes.length > 1) {
      for (let slot = 0; slot < batchPages.length; slot += 1) {
        if (batchPages[slot].length >= config.pageLimit) continue;
        const verified = await fetchKaptureTicketPage(config, range, status, batchIndexes[slot]);
        if (verified.length > batchPages[slot].length) {
          batchPages[slot] = verified;
          repairedPages += 1;
        }
      }
    }

    let batchCount = 0;
    for (const pageTickets of batchPages) {
      tickets.push(...pageTickets);
      batchCount += pageTickets.length;
    }

    pageIndex += batchIndexes.length;

    if (batchCount === 0) {
      if (repairedPages) {
        console.warn(`Kapture "${status}" fetch repaired ${repairedPages} truncated page(s); lower KAPTURE_PAGE_CONCURRENCY (currently ${config.pageConcurrency}) to avoid the retries.`);
      }
      return tickets;
    }
    previousPageFull = batchPages.at(-1).length >= config.pageLimit;
  }

  console.warn(
    `Kapture ${status} fetch hit the ${config.maxPages}-page cap for ${range.startDate}..${range.endDate}; counts may be short. Raise KAPTURE_MAX_PAGES.`,
  );
  return tickets;
}

async function fetchKaptureTicketPage(config, range, status, pageIndex) {
  const offset = pageIndex * config.pageLimit;
  const attempt = {
    body: JSON.stringify([buildKapturePayload(range, status, config.pageLimit, offset)]),
    bodyFormat: "json",
    params: {},
  };

  const payload = await callKaptureWithRetry(config, attempt);
  return extractTickets(payload).map((ticket) => ({ ...ticket, __fetchStatus: status || "all" }));
}

function countBy(items, field) {
  return items.reduce((counts, item) => {
    const key = String(item?.[field] || "unknown");
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function countResolvedDates(tickets) {
  const counts = {};
  for (const ticket of tickets) {
    const dateKey = parseKaptureDateKey(ticket?.taskEnddate);
    if (!dateKey) continue;
    counts[dateKey] = (counts[dateKey] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14));
}

function getStatusCacheKey(config, range, status) {
  return JSON.stringify({
    version: CACHE_SCHEMA_VERSION,
    status,
    range: {
      startDate: range.startDate,
      endDate: range.endDate,
    },
    baseUrl: config.baseUrl,
    endpoint: config.endpoint,
    method: config.method,
    pageLimit: config.pageLimit,
    maxPages: config.maxPages,
    startParam: process.env.KAPTURE_START_DATE_PARAM,
    endParam: process.env.KAPTURE_END_DATE_PARAM,
    dateValueMode: config.dateValueMode,
  });
}

async function readStatusCache(cacheKey) {
  try {
    const raw = await readFile(statusCachePath(cacheKey), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tickets) || !Number.isFinite(parsed.createdAt)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeStatusCache(cacheKey, tickets) {
  try {
    await mkdir(STATUS_CACHE_DIR, { recursive: true });
    await writeFile(statusCachePath(cacheKey), JSON.stringify({ createdAt: Date.now(), tickets }), "utf8");
  } catch {
    // Disk cache is a resilience layer; live data should continue even if this write fails.
  }
}

function statusCachePath(cacheKey) {
  return path.join(STATUS_CACHE_DIR, `${hashText(cacheKey)}.json`);
}

function hashText(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

function getStatusFetchRange(range, status) {
  if (isCompletedStatusParam(status) && range.completedStartDate) {
    return { ...range, startDate: range.completedStartDate };
  }
  return range;
}

function isCompletedStatusParam(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return ["c", "complete", "completed", "resolved", "closed"].includes(normalized);
}

function addTicketVersion(allTickets, ticketIndexes, ticket) {
  const key = ticket.ticketId || `${ticket.date}|${ticket.taskTitle}|${ticket.queueName}|${ticket.status}`;
  if (ticketIndexes.has(key)) {
    const existingIndex = ticketIndexes.get(key);
    const existingTicket = allTickets[existingIndex];
    allTickets[existingIndex] = chooseTicketVersion(existingTicket, ticket);
    return;
  }
  ticketIndexes.set(key, allTickets.length);
  allTickets.push(ticket);
}

function chooseTicketVersion(existing, incoming) {
  const existingResolved = isResolvedTicket(existing) || Boolean(existing.taskEnddate);
  const incomingResolved = isResolvedTicket(incoming) || Boolean(incoming.taskEnddate);

  if (incomingResolved && !existingResolved) {
    return mergeTicketVersions(existing, incoming);
  }

  if (incomingResolved && existingResolved) {
    const existingEndTime = parseKaptureTime(existing.taskEnddate);
    const incomingEndTime = parseKaptureTime(incoming.taskEnddate);
    if (incomingEndTime >= existingEndTime) return mergeTicketVersions(existing, incoming);
  }

  return existing;
}

function mergeTicketVersions(base, preferred) {
  const merged = { ...base, ...preferred };
  for (const [key, value] of Object.entries(base)) {
    if (isBlankValue(merged[key]) && !isBlankValue(value)) {
      merged[key] = value;
    }
  }
  return merged;
}

function isBlankValue(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function buildKapturePayload(range, status, limit, offset) {
  return {
    start_date: range.startDate,
    end_date: range.endDate,
    limit: String(limit),
    offset: String(offset),
    phone: "",
    status,
    fd_ticket_detail: [
      {
        from_due_by: "",
        nr_escalated: "",
        urgent: "",
        source_name: "",
        fwd_email: "",
        nr_dueby: "",
        to_email: "",
        product_name: "",
        cc_email: "",
        substatus_name: "",
        requester_status_name: "",
        fr_escalated: "",
        reply_cc_email: "",
        group_name: "",
        responder_name: "",
        priority_name: "",
        requester_name: "",
        tags: "",
        ticket_type: "",
      },
    ],
    fd_custom_ticket_detail: [
      {
        remarks: "",
        issue_category: "",
        tickets_attributes: "",
        time_trigger: "",
        is_auto_closed: "",
      },
    ],
    valmo_tech_support: [
      {
        db_updates: "",
        support_instruction: "",
        ticket_attributes: "",
      },
    ],
  };
}

async function callKaptureWithRetry(config, attempt) {
  let lastError;
  for (let retry = 0; retry < 3; retry += 1) {
    try {
      return await callKapture(config, attempt);
    } catch (error) {
      lastError = error;
      if (error.statusCode && error.statusCode < 500) break;
      await sleep(500 + retry * 1_000);
    }
  }
  throw lastError;
}

function buildAttempt(config, startParam, endParam, startValue, endValue, bodyFormat) {
  const params = { [startParam]: startValue, [endParam]: endValue };

  if (config.method === "GET") {
    return { params, body: undefined, bodyFormat: "query" };
  }

  if (bodyFormat === "form") {
    return {
      params,
      body: new URLSearchParams(params).toString(),
      bodyFormat,
    };
  }

  return { params, body: JSON.stringify(params), bodyFormat };
}

async function callKapture(config, attempt) {
  const endpointUrl = resolveEndpoint(config.baseUrl, config.endpoint);
  const url = new URL(endpointUrl);
  const controller = new AbortController();
  const timeout = Number(attempt.timeoutMs || config.requestTimeoutMs || REQUEST_TIMEOUT_MS);
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const headers = {
    Accept: "application/json",
    ...config.extraHeaders,
  };

  const authValue = config.authPrefix ? `${config.authPrefix} ${config.token}` : config.token;
  headers[config.authHeader] = authValue;
  if (config.cookie) headers.Cookie = config.cookie;

  const requestOptions = {
    method: config.method,
    headers,
    signal: controller.signal,
  };

  if (attempt.bodyFormat === "query") {
    for (const [key, value] of Object.entries(attempt.params)) {
      url.searchParams.set(key, value);
    }
  } else {
    headers["Content-Type"] = attempt.bodyFormat === "form"
      ? "application/x-www-form-urlencoded; charset=utf-8"
      : "application/json; charset=utf-8";
    requestOptions.body = attempt.body;
  }

  let response;
  let text;

  try {
    response = await fetch(url, requestOptions);
    text = await response.text();
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Kapture API timed out after ${Math.round(timeout / 1000)} seconds.`);
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const payload = parseResponseBody(text);

  if (!response.ok) {
    const message = extractErrorMessage(payload) || text || response.statusText;
    const error = new Error(`Kapture API returned ${response.status}: ${message.slice(0, 500)}`);
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(message);
      error.statusCode = 504;
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveEndpoint(baseUrl, endpoint) {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}${suffix}`;
}

function parseResponseBody(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function extractErrorMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  return payload.message || payload.error || payload.errorMessage || payload.statusMessage || "";
}

function extractTickets(payload) {
  if (Array.isArray(payload)) return normalizeTickets(payload);

  const directKeys = ["tickets", "data", "result", "results", "ticketList", "taskList", "rows"];
  for (const key of directKeys) {
    if (Array.isArray(payload?.[key])) {
      return normalizeTickets(payload[key]);
    }
  }

  let best = [];
  visit(payload);
  return normalizeTickets(best);

  function visit(value) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      if (value.length > best.length && looksLikeTicketArray(value)) {
        best = value;
      }
      for (const item of value.slice(0, 20)) visit(item);
      return;
    }

    for (const child of Object.values(value)) visit(child);
  }
}

function looksLikeTicketArray(items) {
  return items.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    return ["ticketId", "taskTitle", "status", "date", "queueName", "creatorName"].some((key) => key in item);
  });
}

function normalizeTickets(items) {
  return items
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      ...item,
      ticketId: valueOf(item.ticketId ?? item.ticket_id ?? item.id),
      taskTitle: valueOf(item.taskTitle ?? item.title ?? item.subject),
      date: valueOf(item.date ?? item.createdDate ?? item.created_date ?? item.taskCreatedDate),
      status: valueOf(item.status ?? item.ticketStatus),
      taskEnddate: valueOf(item.taskEnddate ?? item.taskEndDate ?? item.resolvedDate ?? item.completedDate),
      lastFollowUp: valueOf(item.lastFollowUp ?? item.last_follow_up ?? item.updatedDate ?? item.updated_date),
      lastConversationTime: valueOf(item.lastConversationTime ?? item.lastConvesationTime ?? item.last_conversation_time),
      queueName: valueOf(item.queueName ?? item.queue_name ?? item.queue),
      creatorName: valueOf(item.creatorName ?? item.creator_name ?? item.createdBy),
      assignedToName: valueOf(item.assignedToName ?? item.assigned_to_name ?? item.assignedTo),
      responderName: valueOf(item.responderName ?? item.responder_name ?? item.additional_info?.fd_ticket_detail?.responder_name),
      priorityName: valueOf(item.priorityName ?? item.priority_name ?? item.priority ?? item.additional_info?.fd_ticket_detail?.priority_name),
      substatus: valueOf(item.substatus ?? item.subStatus),
      attachments: item.attachments ?? "",
    }));
}

function valueOf(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function applyFilters(tickets, filters) {
  return tickets.filter((ticket) => {
    const title = ticket.taskTitle.toLowerCase();
    return matchesContains(ticket.queueName, filters.queueName)
      && matchesContains(ticket.creatorName, filters.creatorName)
      && (!filters.titlePrefix || title.startsWith(filters.titlePrefix.toLowerCase()))
      && (!filters.titleContains || title.includes(filters.titleContains.toLowerCase()));
  });
}

function matchesContains(value, needle) {
  return !needle || String(value || "").toLowerCase().includes(needle.toLowerCase());
}

function summarizeTickets(tickets, range) {
  const days = listDateKeys(range.startDate, range.endDate);
  const rangeStartTime = Date.parse(`${range.startDate}T00:00:00`);
  const dailyMap = new Map(days.map((day) => [day, {
    date: day,
    created: 0,
    resolved: 0,
    pendingCreated: 0,
    openBacklog: 0,
  }]));

  const pendingTickets = [];
  const createdTickets = [];
  const completedTickets = [];
  const queueCounts = new Map();
  const creatorCounts = new Map();
  const teammateDailyCounts = new Map();
  const resolvedPriorityCounts = new Map();
  const completedByCounts = new Map();
  const resolvedSubstatusCounts = new Map();

  for (const ticket of tickets) {
    const createdDay = parseKaptureDateKey(ticket.date);
    const resolvedDay = parseKaptureDateKey(ticket.taskEnddate);
    const attemptedDay = parseKaptureDateKey(ticket.lastFollowUp || ticket.lastConversationTime || ticket.date);
    const isResolved = isResolvedTicket(ticket);
    const createdOnly = Boolean(ticket.__createdOnly);
    const teammateName = getTeammateName(ticket);
    const createdInRange = Boolean(createdDay && dailyMap.has(createdDay));

    if (createdInRange) {
      dailyMap.get(createdDay).created += 1;
      if (!createdOnly && !isResolved) dailyMap.get(createdDay).pendingCreated += 1;
      createdTickets.push(ticket);
      incrementBreakdown(queueCounts, ticket.queueName || "Unassigned", isResolved);
      incrementBreakdown(creatorCounts, ticket.creatorName || "Unknown", isResolved);
    }

    if (resolvedDay && dailyMap.has(resolvedDay)) {
      dailyMap.get(resolvedDay).resolved += 1;
      incrementResolvedPriority(resolvedPriorityCounts, teammateName, getPriorityName(ticket));
      const completedBy = getCompleterName(ticket);
      completedTickets.push({ ...ticket, completedByName: completedBy });
      incrementCompletedBy(completedByCounts, completedBy);
      incrementSubstatus(resolvedSubstatusCounts, ticket.substatus);
      incrementTeammateDay(teammateDailyCounts, resolvedDay, teammateName, "solved");
    }

    if (createdOnly) continue;

    if (attemptedDay && dailyMap.has(attemptedDay)) {
      incrementTeammateDay(teammateDailyCounts, attemptedDay, teammateName, "attempted");
    }

    if (createdInRange && !isResolved) {
      pendingTickets.push(ticket);
    }
  }

  for (const day of days) {
    const endOfDay = Date.parse(`${day}T23:59:59`);
    let openBacklog = 0;

    for (const ticket of tickets) {
      if (ticket.__createdOnly) continue;
      const createdAt = parseKaptureTime(ticket.date);
      const resolvedAt = parseKaptureTime(ticket.taskEnddate);
      const teammateName = getTeammateName(ticket);
      if (!createdAt || createdAt < rangeStartTime || createdAt > endOfDay) continue;
      if (!resolvedAt || resolvedAt > endOfDay) {
        openBacklog += 1;
        incrementTeammateDay(teammateDailyCounts, day, teammateName, "openBacklog");
      }
    }

    dailyMap.get(day).openBacklog = openBacklog;
  }

  const daily = [...dailyMap.values()];
  const totals = {
    created: daily.reduce((sum, item) => sum + item.created, 0),
    resolved: daily.reduce((sum, item) => sum + item.resolved, 0),
    pending: pendingTickets.length,
    endBacklog: daily.at(-1)?.openBacklog || 0,
    // "resolved" above is every Complete ticket. resolvedStrict counts only the
    // ones Kapture marks substatus=Resolved, i.e. excluding Closed and Replied.
    resolvedStrict: strictResolvedCount(resolvedSubstatusCounts),
  };

  createdTickets.sort((a, b) => (parseKaptureTime(b.date) || 0) - (parseKaptureTime(a.date) || 0));
  pendingTickets.sort((a, b) => (parseKaptureTime(b.date) || 0) - (parseKaptureTime(a.date) || 0));
  completedTickets.sort((a, b) => (parseKaptureTime(b.taskEnddate) || 0) - (parseKaptureTime(a.taskEnddate) || 0));

  return {
    totals,
    daily,
    topQueues: topBreakdown(queueCounts),
    topCreators: topBreakdown(creatorCounts),
    teammateDaily: teammateDailyRows(teammateDailyCounts),
    resolvedPriority: resolvedPriorityRows(resolvedPriorityCounts),
    createdTickets,
    pendingTickets,
    completedTickets,
    completedByTeammate: completedByRows(completedByCounts),
    resolvedBySubstatus: substatusRows(resolvedSubstatusCounts),
  };
}

function normalizeSubstatus(value) {
  return String(value || "").trim() || "Unspecified";
}

function incrementSubstatus(map, value) {
  const key = normalizeSubstatus(value);
  map.set(key, (map.get(key) || 0) + 1);
}

function substatusRows(map) {
  return [...map.entries()]
    .map(([substatus, count]) => ({ substatus, count }))
    .sort((a, b) => b.count - a.count || a.substatus.localeCompare(b.substatus));
}

function strictResolvedCount(map) {
  let total = 0;
  for (const [substatus, count] of map) {
    if (substatus.toLowerCase() === "resolved") total += count;
  }
  return total;
}

function applyPerformanceTotals(summary, performanceTotals, range) {
  summary.localTotals = { ...summary.totals };
  summary.metricSource = "ticket-list";
  summary.metricSources = {
    created: "ticket-list",
    resolved: "ticket-list",
    pending: "ticket-list",
    endBacklog: "ticket-list",
  };

  if (!performanceTotals) return;

  let applied = false;
  if (Number.isFinite(performanceTotals.created)) {
    summary.totals.created = performanceTotals.created;
    if (range.days === 1 && summary.daily[0]) summary.daily[0].created = performanceTotals.created;
    summary.metricSources.created = "performance-dashboard";
    applied = true;
  }

  if (Number.isFinite(performanceTotals.resolved)) {
    summary.totals.resolved = performanceTotals.resolved;
    if (range.days === 1 && summary.daily[0]) summary.daily[0].resolved = performanceTotals.resolved;
    summary.metricSources.resolved = "performance-dashboard";
    applied = true;
  }

  if (applied) {
    summary.metricSource = "performance-dashboard";
  }
}

function buildMetricDiagnostics(summary, performanceTotals, performanceError) {
  const config = getKaptureConfig();
  return {
    headlineSource: summary.metricSource,
    fieldSources: summary.metricSources,
    localTotals: summary.localTotals,
    performanceTotals: {
      created: Number.isFinite(performanceTotals?.created) ? performanceTotals.created : null,
      resolved: Number.isFinite(performanceTotals?.resolved) ? performanceTotals.resolved : null,
    },
    performanceAgentFilter: config.performanceAgentIds || "all-teammates",
    performanceError: performanceError || "",
  };
}

function getPriorityName(ticket) {
  const priority = String(ticket.priorityName || "").trim();
  if (!priority) return "No priority";
  return priority.charAt(0).toUpperCase() + priority.slice(1).toLowerCase();
}

function incrementResolvedPriority(map, teammate, priority) {
  const key = `${teammate}||${priority}`;
  const row = map.get(key) || { teammate, priority, count: 0 };
  row.count += 1;
  map.set(key, row);
}

function resolvedPriorityRows(map) {
  return [...map.values()].sort((a, b) => a.teammate.localeCompare(b.teammate)
    || b.count - a.count
    || a.priority.localeCompare(b.priority));
}

function getTeammateName(ticket) {
  const candidates = [
    ticket.assignedToName,
    ticket.creatorName,
    ticket.responderName,
  ].map((value) => String(value || "").trim());
  const name = candidates.find((value) => value && value.toLowerCase() !== "no agent");
  return name || "Unassigned";
}

function getCompleterName(ticket) {
  const candidates = [
    ticket.responderName,
    ticket.assignedToName,
    ticket.creatorName,
  ].map((value) => String(value || "").trim());
  const name = candidates.find((value) => value && value.toLowerCase() !== "no agent");
  return name || "Unassigned";
}

function incrementCompletedBy(map, teammate) {
  const name = teammate || "Unassigned";
  map.set(name, (map.get(name) || 0) + 1);
}

function completedByRows(map) {
  return [...map.entries()]
    .map(([teammate, completed]) => ({ teammate, completed }))
    .sort((a, b) => b.completed - a.completed || a.teammate.localeCompare(b.teammate));
}

function incrementTeammateDay(map, date, teammate, field) {
  const key = `${date}||${teammate}`;
  const row = map.get(key) || { date, teammate, attempted: 0, solved: 0, openBacklog: 0 };
  row[field] += 1;
  map.set(key, row);
}

function teammateDailyRows(map) {
  return [...map.values()]
    .filter((row) => row.attempted || row.solved || row.openBacklog)
    .sort((a, b) => b.date.localeCompare(a.date)
      || b.solved - a.solved
      || b.attempted - a.attempted
      || b.openBacklog - a.openBacklog
      || a.teammate.localeCompare(b.teammate));
}

function incrementBreakdown(map, key, isResolved) {
  const current = map.get(key) || { name: key, total: 0, pending: 0, resolved: 0 };
  current.total += 1;
  if (isResolved) current.resolved += 1;
  else current.pending += 1;
  map.set(key, current);
}

function topBreakdown(map) {
  return [...map.values()]
    .sort((a, b) => b.total - a.total || b.pending - a.pending || a.name.localeCompare(b.name))
    .slice(0, 10);
}

function isResolvedTicket(ticket) {
  const status = String(ticket.status || "").toLowerCase();
  return ["complete", "completed", "resolved", "closed", "done"].some((word) => status.includes(word));
}

function parseKaptureDateKey(value) {
  const time = parseKaptureTime(value);
  return time ? toDateKey(new Date(time)) : "";
}

function parseKaptureTime(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "0000-00-00" || raw.startsWith("0000-00-00")) return 0;

  // Kapture sends day-first dates (`18-08-2026 13:04`). This must be tried BEFORE
  // Date.parse: V8 rejects the form when a time is attached but silently accepts the
  // date-only form as month-first, so `08-09-2026` (8 Sep) landed on 9 Aug. The
  // pattern needs a 4-digit trailing year, so ISO values fall through untouched.
  const match = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const [, d, m, y, hh = "0", mm = "0", ss = "0"] = match;
    return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)).getTime();
  }

  const isoLike = raw.includes("T") ? raw : raw.replace(" ", "T");
  const parsed = Date.parse(isoLike);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function dailyRowsToCsv(rows) {
  return toCsv(["date", "created", "resolved", "pending_created", "open_backlog"], rows.map((row) => [
    row.date,
    row.created,
    row.resolved,
    row.pendingCreated,
    row.openBacklog,
  ]));
}

function createdRowsToCsv(rows) {
  return toCsv([
    "ticketId",
    "createdDate",
    "status",
    "substatus",
    "resolvedDate",
    "queueName",
    "creatorName",
    "assignedToName",
    "priority",
    "taskTitle",
    "attachments",
  ], rows.map((ticket) => [
    ticket.ticketId,
    ticket.date,
    ticket.status,
    ticket.substatus,
    ticket.taskEnddate,
    ticket.queueName,
    ticket.creatorName,
    ticket.assignedToName,
    getPriorityName(ticket),
    ticket.taskTitle,
    serializeAttachments(ticket.attachments),
  ]));
}

function pendingRowsToCsv(rows) {
  return toCsv([
    "ticketId",
    "date",
    "status",
    "taskTitle",
    "queueName",
    "creatorName",
    "assignedToName",
    "substatus",
    "attachments",
  ], rows.map((ticket) => [
    ticket.ticketId,
    ticket.date,
    ticket.status,
    ticket.taskTitle,
    ticket.queueName,
    ticket.creatorName,
    ticket.assignedToName,
    ticket.substatus,
    serializeAttachments(ticket.attachments),
  ]));
}

function completedRowsToCsv(rows) {
  return toCsv([
    "ticketId",
    "completedDate",
    "completedBy",
    "priority",
    "status",
    "taskTitle",
    "queueName",
    "creatorName",
    "assignedToName",
    "substatus",
    "createdDate",
    "attachments",
  ], rows.map((ticket) => [
    ticket.ticketId,
    ticket.taskEnddate,
    ticket.completedByName,
    getPriorityName(ticket),
    ticket.status,
    ticket.taskTitle,
    ticket.queueName,
    ticket.creatorName,
    ticket.assignedToName,
    ticket.substatus,
    ticket.date,
    serializeAttachments(ticket.attachments),
  ]));
}

function teammateRowsToCsv(rows) {
  return toCsv([
    "date",
    "teammate",
    "attempted",
    "solved",
    "open_backlog",
  ], rows.map((row) => [
    row.date,
    row.teammate,
    row.attempted,
    row.solved,
    row.openBacklog,
  ]));
}

function serializeAttachments(value) {
  if (Array.isArray(value)) return value.map(attachmentToText).filter(Boolean).join(" | ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return value || "";
}

function attachmentToText(attachment) {
  if (!attachment || typeof attachment !== "object") return attachment || "";
  return [attachment.name, attachment.url].filter(Boolean).join(" - ");
}

function toCsv(headers, rows) {
  return [
    headers.join(","),
    ...rows.map((row) => row.map(escapeCsv).join(",")),
  ].join("\n");
}

function escapeCsv(value) {
  const raw = value === null || value === undefined ? "" : String(value);
  if (!/[",\n\r]/.test(raw)) return raw;
  return `"${raw.replaceAll('"', '""')}"`;
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendCsv(res, filename, body) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function sanitizeError(error) {
  let message = error?.message || "Unexpected server error";
  const token = process.env.KAPTURE_LIST_AUTH_TOKEN;
  if (token) message = message.replaceAll(token, "[redacted]");
  return message;
}

function normalizeDateKey(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
  return raw;
}

function formatApiDate(dateKey, side, mode) {
  if (mode === "datetime") {
    return side === "start" ? `${dateKey} 00:00:00` : `${dateKey} 23:59:59`;
  }
  return dateKey;
}

function listDateKeys(startDate, endDate) {
  const dates = [];
  let current = startDate;
  while (current <= endDate) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function addDays(dateKey, delta) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day + delta);
  return toDateKey(date);
}

function daysBetween(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00`);
  const end = Date.parse(`${endDate}T00:00:00`);
  return Math.round((end - start) / 86_400_000);
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
