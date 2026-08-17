import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
  const index = trimmed.indexOf("=");
  env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
}

const url = `${env.KAPTURE_BASE_URL}${env.KAPTURE_TICKET_LIST_ENDPOINT}`;
const headers = {
  Accept: "application/json",
  "Content-Type": "application/json; charset=utf-8",
  Authorization: `${env.KAPTURE_AUTH_PREFIX} ${env.KAPTURE_LIST_AUTH_TOKEN}`,
  Cookie: env.KAPTURE_COOKIE,
};

const startDate = process.argv[2] || "2026-06-01";
const endDate = process.argv[3] || "2026-06-19";
const status = process.argv[4] || "P";

function buildPayload(offset) {
  return {
    start_date: startDate,
    end_date: endDate,
    limit: "500",
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

function extract(payload) {
  let best = [];
  visit(payload);
  return best;

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
    return ["ticketId", "taskTitle", "status", "date", "queueName", "creatorName", "taskId"].some((key) => key in item);
  });
}

const all = [];
const pages = [];
for (let page = 0; page < 50; page += 1) {
  const response = await fetchPage(page * 500);
  const payload = await response.json();
  const rows = extract(payload);
  pages.push(rows.length);
  all.push(...rows);
  if (rows.length < 500) break;
}

async function fetchPage(offset) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify([buildPayload(offset)]),
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 + attempt * 1000));
    }
  }
  throw lastError;
}

const seen = new Set();
const unique = [];
let duplicates = 0;
for (const ticket of all) {
  const key = String(ticket.ticketId ?? ticket.ticket_id ?? ticket.id ?? "") || [
    ticket.date,
    ticket.taskTitle,
    ticket.queueName,
    ticket.status,
  ].join("|");
  if (seen.has(key)) {
    duplicates += 1;
  } else {
    seen.add(key);
    unique.push(ticket);
  }
}

const byStatus = {};
const bySubstatus = {};
let createdInRange = 0;
let createdBefore = 0;
let createdAfter = 0;
let unparsedDate = 0;
for (const ticket of unique) {
  byStatus[String(ticket.status || "blank")] = (byStatus[String(ticket.status || "blank")] || 0) + 1;
  bySubstatus[String(ticket.substatus || "blank")] = (bySubstatus[String(ticket.substatus || "blank")] || 0) + 1;
  const dateKey = parseDateKey(ticket.date);
  if (!dateKey) unparsedDate += 1;
  else if (dateKey < startDate) createdBefore += 1;
  else if (dateKey > endDate) createdAfter += 1;
  else createdInRange += 1;
}

console.log(JSON.stringify({
  startDate,
  endDate,
  status,
  pages,
  rawCount: all.length,
  uniqueCount: unique.length,
  duplicates,
  createdInRange,
  createdBefore,
  createdAfter,
  unparsedDate,
  byStatus,
  bySubstatus: Object.entries(bySubstatus).sort((a, b) => b[1] - a[1]).slice(0, 20),
}, null, 2));

function parseDateKey(value) {
  const raw = String(value || "").trim();
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (!match) return "";
  const [, day, month, year] = match;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
