const elements = {
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  startDate: document.querySelector("#startDate"),
  endDate: document.querySelector("#endDate"),
  queueName: document.querySelector("#queueName"),
  creatorName: document.querySelector("#creatorName"),
  titlePrefix: document.querySelector("#titlePrefix"),
  titleContains: document.querySelector("#titleContains"),
  dateRangeTrigger: document.querySelector("#dateRangeTrigger"),
  dateRangeMenu: document.querySelector("#dateRangeMenu"),
  dateRangeValue: document.querySelector("#dateRangeValue"),
  customDateFields: document.querySelector("#customDateFields"),
  customStartDate: document.querySelector("#customStartDate"),
  customEndDate: document.querySelector("#customEndDate"),
  applyCustomRange: document.querySelector("#applyCustomRange"),
  agentTrigger: document.querySelector("#agentTrigger"),
  agentMenu: document.querySelector("#agentMenu"),
  agentValue: document.querySelector("#agentValue"),
  agentList: document.querySelector("#agentList"),
  refreshButton: document.querySelector("#refreshButton"),
  dailyCsv: document.querySelector("#dailyCsv"),
  createdCsv: document.querySelector("#createdCsv"),
  teamCsv: document.querySelector("#teamCsv"),
  pendingCsv: document.querySelector("#pendingCsv"),
  resolvedCsv: document.querySelector("#resolvedCsv"),
  createdMetric: document.querySelector("#createdMetric"),
  createdMetricHelp: document.querySelector("#createdMetricHelp"),
  resolvedMetric: document.querySelector("#resolvedMetric"),
  resolvedMetricHelp: document.querySelector("#resolvedMetricHelp"),
  pendingMetric: document.querySelector("#pendingMetric"),
  pendingMetricHelp: document.querySelector("#pendingMetricHelp"),
  backlogMetric: document.querySelector("#backlogMetric"),
  backlogMetricHelp: document.querySelector("#backlogMetricHelp"),
  teamResolvedList: document.querySelector("#teamResolvedList"),
  teamResolvedDonut: document.querySelector("#teamResolvedDonut"),
  teamResolvedTotal: document.querySelector("#teamResolvedTotal"),
  teamResolvedCountLabel: document.querySelector("#teamResolvedCountLabel"),
  teamResolvedPager: document.querySelector("#teamResolvedPager"),
  teamResolvedPrev: document.querySelector("#teamResolvedPrev"),
  teamResolvedNext: document.querySelector("#teamResolvedNext"),
  teamResolvedPageLabel: document.querySelector("#teamResolvedPageLabel"),
  resolvedDetailsBody: document.querySelector("#resolvedDetailsBody"),
  ticketDetailsTitle: document.querySelector("#ticketDetailsTitle"),
  ticketDetailsCountLabel: document.querySelector("#ticketDetailsCountLabel"),
  ticketSearch: document.querySelector("#ticketSearch"),
  pendingTabButton: document.querySelector("#pendingTabButton"),
  resolvedTabButton: document.querySelector("#resolvedTabButton"),
  pendingPanel: document.querySelector("#pendingPanel"),
  resolvedPanel: document.querySelector("#resolvedPanel"),
  pendingBody: document.querySelector("#pendingBody"),
  messageBand: document.querySelector("#messageBand"),
  messageTitle: document.querySelector("#messageTitle"),
  messageText: document.querySelector("#messageText"),
};

const formatter = new Intl.NumberFormat("en-IN");
const DASHBOARD_TIMEOUT_MS = 90_000;
let currentLoadId = 0;
let currentPayload = null;
let openWorkTab = "pending";
let teamResolvedPage = 0;
const selectedAgents = new Set(["__all"]);
const teammateColors = ["#5b9bea", "#8bc2e3", "#f08c00", "#ffcf5c", "#7d9850", "#6fba79", "#8d7a4c", "#dcc3a6", "#70a7a7", "#a77bd6", "#e76f65", "#4c78a8"];
const teammateLegendPageSize = 8;

boot();

function boot() {
  elements.startDate.value = "";
  elements.endDate.value = "";
  elements.queueName.value = "";
  elements.creatorName.value = "";
  elements.titlePrefix.value = "";
  elements.titleContains.value = "";

  elements.dateRangeTrigger.addEventListener("click", () => toggleMenu(elements.dateRangeMenu));
  elements.agentTrigger.addEventListener("click", () => toggleMenu(elements.agentMenu));
  elements.applyCustomRange.addEventListener("click", () => applyCustomRange());
  for (const button of elements.dateRangeMenu.querySelectorAll("[data-range]")) {
    button.addEventListener("click", () => chooseDateRange(button.dataset.range));
  }

  elements.refreshButton.addEventListener("click", () => loadDashboard());
  elements.ticketSearch.addEventListener("input", () => renderOpenWork(currentPayload));
  elements.teamResolvedPrev.addEventListener("click", () => changeTeamResolvedPage(-1));
  elements.teamResolvedNext.addEventListener("click", () => changeTeamResolvedPage(1));
  for (const button of [elements.pendingTabButton, elements.resolvedTabButton]) {
    button.addEventListener("click", () => {
      openWorkTab = button.dataset.openWorkTab;
      renderOpenWork(currentPayload);
    });
  }

  renderEmptyState();
  setStatus("loading", "Select dates");
  showMessage("Select a date range", "Choose Date Range, then click Refresh if needed.");
}

function filterInputs() {
  return [
    elements.startDate,
    elements.endDate,
    elements.queueName,
    elements.creatorName,
    elements.titlePrefix,
    elements.titleContains,
  ];
}

async function loadDashboard() {
  const loadId = currentLoadId + 1;
  currentLoadId = loadId;

  if (!hasDateRange()) {
    renderEmptyState();
    setStatus("loading", "Select dates");
    showMessage("Select a date range", "Choose Start and End dates, then click Refresh.");
    return;
  }

  const params = currentParams();
  params.set("_", String(Date.now()));
  const query = params.toString();
  setStatus("loading", "Refreshing");
  hideMessage();
  elements.refreshButton.disabled = true;
  elements.refreshButton.textContent = "Refreshing";
  elements.dailyCsv.href = `/api/export/daily.csv?${query}`;
  elements.createdCsv.href = `/api/export/created.csv?${query}`;
  elements.teamCsv.href = `/api/export/team.csv?${query}`;
  elements.pendingCsv.href = `/api/export/pending.csv?${query}`;
  elements.resolvedCsv.href = `/api/export/resolved.csv?${query}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DASHBOARD_TIMEOUT_MS);
    const response = await fetch(`/api/tickets?${query}`, { signal: controller.signal })
      .finally(() => clearTimeout(timeoutId));
    const payload = await response.json();

    if (loadId !== currentLoadId) return;

    if (!response.ok) {
      throw new Error(payload.error || "Unable to load Kapture data.");
    }

    renderDashboard(payload);
    setStatus("live", `Live ${formatClock(payload.fetchedAt)}`);
  } catch (error) {
    if (loadId !== currentLoadId) return;
    const message = error?.name === "AbortError"
      ? "Kapture is taking longer than expected. Please refresh again; the dashboard will not stay stuck."
      : error.message;
    setStatus("error", "Data delayed");
    renderEmptyState();
    showMessage("Live data unavailable", message);
  } finally {
    if (loadId === currentLoadId) {
      elements.refreshButton.disabled = false;
      elements.refreshButton.textContent = "Refresh";
    }
  }
}

function currentParams() {
  const params = new URLSearchParams();
  setParam(params, "startDate", elements.startDate.value);
  setParam(params, "endDate", elements.endDate.value);
  setParam(params, "queueName", elements.queueName.value);
  setParam(params, "creatorName", elements.creatorName.value);
  setParam(params, "titlePrefix", elements.titlePrefix.value);
  setParam(params, "titleContains", elements.titleContains.value);
  return params;
}

function hasDateRange() {
  return Boolean(validDateInput(elements.startDate.value) && validDateInput(elements.endDate.value));
}

function setParam(params, key, value) {
  const trimmed = String(value || "").trim();
  if (trimmed) params.set(key, trimmed);
}

function validDateInput(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function toggleMenu(menu) {
  menu.hidden = !menu.hidden;
}

function chooseDateRange(rangeType) {
  const now = new Date();
  let start = now;
  let end = now;
  let label = "Selected range";

  if (rangeType === "custom") {
    elements.customDateFields.hidden = false;
    return;
  }

  elements.customDateFields.hidden = true;

  if (rangeType === "yesterday") {
    start = addDays(now, -1);
    end = addDays(now, -1);
    label = "Yesterday";
  } else if (rangeType === "week") {
    start = startOfWeek(now);
    label = "This Week";
  } else if (rangeType === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    label = "This Month";
  } else {
    label = "Today";
  }

  elements.startDate.value = toDateInputValue(start);
  elements.endDate.value = toDateInputValue(end);
  elements.dateRangeValue.textContent = label;
  elements.dateRangeMenu.hidden = true;
  loadDashboard();
}

function applyCustomRange() {
  const start = datePart(elements.customStartDate.value);
  const end = datePart(elements.customEndDate.value);
  if (!start || !end) {
    showMessage("Select custom dates", "Choose both Start Date & Time and End Date & Time.");
    return;
  }

  elements.startDate.value = start;
  elements.endDate.value = end;
  elements.dateRangeValue.textContent = "Custom Date & Time";
  elements.dateRangeMenu.hidden = true;
  loadDashboard();
}

function datePart(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

function startOfWeek(date) {
  const copy = new Date(date);
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return copy;
}

function renderDashboard(payload) {
  currentPayload = payload;
  elements.createdMetric.textContent = formatter.format(payload.totals.created);
  elements.resolvedMetric.textContent = formatter.format(payload.totals.resolved);
  elements.pendingMetric.textContent = formatter.format(payload.totals.pending);
  elements.backlogMetric.textContent = formatter.format(payload.totals.endBacklog);
  elements.createdMetricHelp.textContent = metricSourceLabel(payload, "created");
  elements.resolvedMetricHelp.textContent = metricSourceLabel(payload, "resolved");
  elements.pendingMetricHelp.textContent = "ticket-list details";
  elements.backlogMetricHelp.textContent = "ticket-list details";

  renderAgentMenu(payload);
  renderTeamResolvedSummary(payload);
  renderOpenWork(payload);
  renderMetricWarning(payload);
}

function metricSourceLabel(payload, field) {
  const source = payload?.metricSources?.[field]
    || payload?.metricDiagnostics?.fieldSources?.[field]
    || payload?.metricSource;
  return source === "performance-dashboard" ? "Kapture dashboard API" : "ticket-list fallback";
}

function renderMetricWarning(payload) {
  const error = payload?.metricDiagnostics?.performanceError;
  const source = payload?.metricDiagnostics?.headlineSource || payload?.metricSource;
  if (error && source !== "performance-dashboard") {
    showMessage(
      "Kapture dashboard API unavailable",
      `Created/Resolved are using ticket-list fallback. ${error}`,
    );
  }
}

function renderAgentMenu(payload) {
  elements.agentList.replaceChildren();
  const agents = getAgents(payload);

  elements.agentList.append(agentCheckbox("All teammates", "__all", selectedAgents.has("__all")));
  for (const agent of agents) {
    elements.agentList.append(agentCheckbox(agent, agent, selectedAgents.has(agent)));
  }

  updateAgentLabel(agents);
}

function getAgents(payload) {
  if (!payload) return [];
  const names = [
    ...(payload.teammateDaily || []).map((row) => row.teammate || "Unassigned"),
    ...(payload.resolvedPriority || []).map((row) => row.teammate || "Unassigned"),
    ...(payload.completedByTeammate || []).map((row) => row.teammate || "Unassigned"),
    ...(payload.completedTickets || []).map((row) => row.completedByName || "Unassigned"),
  ];
  return [...new Set(names.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function agentCheckbox(label, value, checked) {
  const row = document.createElement("label");
  row.className = "agent-check-row";
  row.innerHTML = `<input type="checkbox" value="${escapeHtml(value)}" ${checked ? "checked" : ""}> ${escapeHtml(label)}`;
  row.querySelector("input").addEventListener("change", () => {
    if (value === "__all") {
      selectedAgents.clear();
      selectedAgents.add("__all");
    } else {
      selectedAgents.delete("__all");
      if (selectedAgents.has(value)) selectedAgents.delete(value);
      else selectedAgents.add(value);
      if (!selectedAgents.size) selectedAgents.add("__all");
    }
    teamResolvedPage = 0;
    renderAgentMenu(currentPayload);
    renderTeamResolvedSummary(currentPayload);
    renderOpenWork(currentPayload);
  });
  return row;
}

function updateAgentLabel(agents) {
  if (selectedAgents.has("__all")) {
    elements.agentValue.textContent = "All teammates";
    return;
  }

  const selected = agents.filter((agent) => selectedAgents.has(agent));
  const label = selected.length === 1
    ? selected[0]
    : `${selected.length} teammates selected`;
  elements.agentValue.textContent = label;
}

function renderEmptyState() {
  currentPayload = null;
  elements.createdMetric.textContent = "0";
  elements.resolvedMetric.textContent = "0";
  elements.pendingMetric.textContent = "0";
  elements.backlogMetric.textContent = "0";
  elements.createdMetricHelp.textContent = "tickets in range";
  elements.resolvedMetricHelp.textContent = "using taskEnddate";
  elements.pendingMetricHelp.textContent = "current open items";
  elements.backlogMetricHelp.textContent = "from fetched range";
  renderAgentMenu(null);
  renderTeamResolvedSummary(null);
  renderOpenWork(null);
}

function renderTeamResolvedSummary(payload) {
  elements.teamResolvedList.replaceChildren();
  const rows = selectedResolvedSummary(selectedResolvedTickets(payload));
  const total = rows.reduce((sum, row) => sum + row.resolved, 0);

  elements.teamResolvedCountLabel.textContent = `${formatter.format(rows.length)} teammate${rows.length === 1 ? "" : "s"}`;
  elements.teamResolvedTotal.textContent = formatter.format(total);

  if (!rows.length) {
    elements.teamResolvedDonut.style.background = "radial-gradient(circle, #fff 0 40%, transparent 41%), conic-gradient(#edf1ee 0 100%)";
    elements.teamResolvedPager.hidden = true;
    elements.teamResolvedList.append(emptyLine("No resolved tickets"));
    return;
  }

  renderTeamResolvedDonut(rows, total);

  const pageCount = Math.ceil(rows.length / teammateLegendPageSize);
  teamResolvedPage = Math.min(teamResolvedPage, Math.max(pageCount - 1, 0));
  const visibleRows = rows.slice(
    teamResolvedPage * teammateLegendPageSize,
    teamResolvedPage * teammateLegendPageSize + teammateLegendPageSize,
  );

  for (const row of visibleRows) {
    const percent = total ? ((row.resolved / total) * 100).toFixed(2) : "0.00";
    const item = document.createElement("div");
    item.className = "teammate-legend-row";
    item.innerHTML = `
      <span class="legend-swatch" style="background:${row.color}"></span>
      <span class="legend-name" title="${escapeHtml(row.teammate)}">${escapeHtml(row.teammate)}</span>
      <span class="legend-value">: ${formatter.format(row.resolved)} (${percent}%)</span>
    `;
    elements.teamResolvedList.append(item);
  }

  elements.teamResolvedPager.hidden = pageCount <= 1;
  elements.teamResolvedPageLabel.textContent = `${teamResolvedPage + 1}/${pageCount}`;
  elements.teamResolvedPrev.disabled = teamResolvedPage === 0;
  elements.teamResolvedNext.disabled = teamResolvedPage >= pageCount - 1;
}

function renderTeamResolvedDonut(rows, total) {
  if (!total) {
    elements.teamResolvedDonut.style.background = "radial-gradient(circle, #fff 0 40%, transparent 41%), conic-gradient(#edf1ee 0 100%)";
    return;
  }

  let cursor = 0;
  const slices = rows.map((row) => {
    const start = cursor;
    cursor += (row.resolved / total) * 100;
    return `${row.color} ${start}% ${cursor}%`;
  });
  elements.teamResolvedDonut.style.background = `radial-gradient(circle, #fff 0 40%, transparent 41%), conic-gradient(${slices.join(", ")})`;
}

function changeTeamResolvedPage(delta) {
  const rows = selectedResolvedSummary(selectedResolvedTickets(currentPayload));
  const pageCount = Math.ceil(rows.length / teammateLegendPageSize);
  teamResolvedPage = Math.max(0, Math.min(teamResolvedPage + delta, Math.max(pageCount - 1, 0)));
  renderTeamResolvedSummary(currentPayload);
}

function renderPendingTable(rows) {
  elements.pendingBody.replaceChildren();

  if (!rows.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="7" class="muted">No pending tickets</td>`;
    elements.pendingBody.append(row);
    return;
  }

  for (const ticket of rows.slice(0, 250)) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="ticket-id">${escapeHtml(ticket.ticketId || "-")}</span></td>
      <td>${escapeHtml(ticket.date || "-")}</td>
      <td>${escapeHtml(ticket.queueName || "-")}</td>
      <td>${escapeHtml(ticket.creatorName || "-")}</td>
      <td>${escapeHtml(ticket.assignedToName || "-")}</td>
      <td>${statusChip(ticket.substatus || ticket.status || "Pending", "pending")}</td>
      <td class="title-cell">${escapeHtml(ticket.taskTitle || "-")}</td>
    `;
    elements.pendingBody.append(row);
  }
}

function renderOpenWork(payload) {
  const isResolved = openWorkTab === "resolved";
  elements.pendingTabButton.classList.toggle("active", openWorkTab === "pending");
  elements.resolvedTabButton.classList.toggle("active", isResolved);
  elements.pendingPanel.hidden = openWorkTab !== "pending";
  elements.resolvedPanel.hidden = !isResolved;

  if (isResolved) {
    const rows = filterTickets(selectedResolvedTickets(payload));
    elements.ticketDetailsTitle.textContent = "Resolved tickets";
    elements.ticketDetailsCountLabel.textContent = `${formatter.format(rows.length)} ticket${rows.length === 1 ? "" : "s"}`;
    renderResolvedDetails(rows);
    return;
  }

  const rows = filterTickets(payload?.pendingTickets || []);
  elements.ticketDetailsTitle.textContent = "Pending tickets";
  elements.ticketDetailsCountLabel.textContent = `${formatter.format(rows.length)} ticket${rows.length === 1 ? "" : "s"}`;
  renderPendingTable(rows);
}

function selectedResolvedTickets(payload) {
  const rows = payload?.completedTickets || [];
  if (selectedAgents.has("__all")) return rows;
  return rows.filter((ticket) => selectedAgents.has(ticket.completedByName || "Unassigned"));
}

function filterTickets(rows) {
  const query = String(elements.ticketSearch.value || "").trim().toLowerCase();
  if (!query) return rows;
  return rows.filter((ticket) => [
    ticket.ticketId,
    ticket.taskTitle,
    ticket.queueName,
    ticket.creatorName,
    ticket.assignedToName,
    ticket.completedByName,
    ticket.status,
    ticket.substatus,
  ].some((value) => String(value || "").toLowerCase().includes(query)));
}

function renderResolvedDetails(rows) {
  elements.resolvedDetailsBody.replaceChildren();

  if (!rows.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="7" class="muted">No resolved tickets</td>`;
    elements.resolvedDetailsBody.append(row);
    return;
  }

  for (const ticket of rows.slice(0, 250)) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="ticket-id">${escapeHtml(ticket.ticketId || "-")}</span></td>
      <td>${escapeHtml(ticket.taskEnddate || "-")}</td>
      <td><span class="person-name">${escapeHtml(ticket.completedByName || "Unassigned")}</span></td>
      <td>${escapeHtml(ticket.priorityName || "No priority")}</td>
      <td>${escapeHtml(ticket.queueName || "-")}</td>
      <td>${statusChip(ticket.substatus || ticket.status || "Resolved", "resolved")}</td>
      <td class="title-cell">${escapeHtml(ticket.taskTitle || "-")}</td>
    `;
    elements.resolvedDetailsBody.append(row);
  }
}

function selectedResolvedSummary(rows) {
  const map = new Map();
  for (const ticket of rows) {
    const name = ticket.completedByName || "Unassigned";
    map.set(name, (map.get(name) || 0) + 1);
  }
  return [...map.entries()]
    .map(([teammate, resolved]) => ({ teammate, resolved }))
    .sort((a, b) => b.resolved - a.resolved || a.teammate.localeCompare(b.teammate))
    .map((row, index) => ({
      ...row,
      color: teammateColors[index % teammateColors.length],
    }));
}

function statusChip(label, tone) {
  return `<span class="status-chip ${tone}">${escapeHtml(label)}</span>`;
}

function emptyLine(text) {
  const element = document.createElement("p");
  element.className = "muted";
  element.textContent = text;
  return element;
}

function setStatus(state, text) {
  elements.statusPill.className = `status-pill ${state === "live" ? "live" : state === "error" ? "error" : ""}`;
  elements.statusText.textContent = text;
}

function showMessage(title, text) {
  elements.messageTitle.textContent = title;
  elements.messageText.textContent = text;
  elements.messageBand.hidden = false;
}

function hideMessage() {
  elements.messageBand.hidden = true;
}

function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addDays(date, delta) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + delta);
  return copy;
}

function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
