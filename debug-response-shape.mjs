import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
  const index = trimmed.indexOf("=");
  env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
}

const response = await fetch(`${env.KAPTURE_BASE_URL}${env.KAPTURE_TICKET_LIST_ENDPOINT}`, {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json; charset=utf-8",
    Authorization: `${env.KAPTURE_AUTH_PREFIX} ${env.KAPTURE_LIST_AUTH_TOKEN}`,
    Cookie: env.KAPTURE_COOKIE,
  },
  body: JSON.stringify([{
    start_date: process.argv[2] || "2026-06-01",
    end_date: process.argv[3] || "2026-06-19",
    limit: "500",
    offset: "0",
    phone: "",
    status: process.argv[4] || "P",
    fd_ticket_detail: [{
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
    }],
    fd_custom_ticket_detail: [{ remarks: "", issue_category: "", tickets_attributes: "", time_trigger: "", is_auto_closed: "" }],
    valmo_tech_support: [{ db_updates: "", support_instruction: "", ticket_attributes: "" }],
  }]),
});

const payload = await response.json();

function summarize(value, depth = 0) {
  if (depth > 3 || value === null || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) {
    return { type: "array", length: value.length, first: summarize(value[0], depth + 1) };
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) out[key] = { type: "array", length: child.length };
    else if (child && typeof child === "object") out[key] = summarize(child, depth + 1);
    else if (/count|total|size|page|limit|offset|status/i.test(key)) out[key] = child;
    else out[key] = typeof child;
  }
  return out;
}

console.log(JSON.stringify({
  httpStatus: response.status,
  shape: summarize(payload),
}, null, 2));
