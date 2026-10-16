const elements = {
  statusPill: document.querySelector("#statusPill"),
  statusText: document.querySelector("#statusText"),
  themeToggle: document.querySelector("#themeToggle"),
  themeIcon: document.querySelector("#themeIcon"),
  rangeSummary: document.querySelector("#rangeSummary"),
  startDate: document.querySelector("#startDate"),
  endDate: document.querySelector("#endDate"),
  queueName: document.querySelector("#queueName"),
  creatorName: document.querySelector("#creatorName"),
  titlePrefix: document.querySelector("#titlePrefix"),
  titleContains: document.querySelector("#titleContains"),
  dateRangeBlock: document.querySelector("#dateRangeBlock"),
  dateRangeTrigger: document.querySelector("#dateRangeTrigger"),
  dateRangeMenu: document.querySelector("#dateRangeMenu"),
  dateRangeValue: document.querySelector("#dateRangeValue"),
  customDateFields: document.querySelector("#customDateFields"),
  customStartDate: document.querySelector("#customStartDate"),
  customEndDate: document.querySelector("#customEndDate"),
  applyCustomRange: document.querySelector("#applyCustomRange"),
  agentBlock: document.querySelector("#agentBlock"),
  agentTrigger: document.querySelector("#agentTrigger"),
  agentMenu: document.querySelector("#agentMenu"),
  agentValue: document.querySelector("#agentValue"),
  agentSearch: document.querySelector("#agentSearch"),
  agentList: document.querySelector("#agentList"),
  exportMenu: document.querySelector("#exportMenu"),
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
  resolvedSplit: document.querySelector("#resolvedSplit"),
  resolvedSplitBar: document.querySelector("#resolvedSplitBar"),
  resolvedSplitKeys: document.querySelector("#resolvedSplitKeys"),
  resolvedInfo: document.querySelector("#resolvedInfo"),
  pendingMetric: document.querySelector("#pendingMetric"),
  pendingMetricHelp: document.querySelector("#pendingMetricHelp"),
  backlogMetric: document.querySelector("#backlogMetric"),
  backlogMetricHelp: document.querySelector("#backlogMetricHelp"),
  createdSpark: document.querySelector("#createdSpark"),
  resolvedSpark: document.querySelector("#resolvedSpark"),
  pendingSpark: document.querySelector("#pendingSpark"),
  backlogSpark: document.querySelector("#backlogSpark"),
  trendWrap: document.querySelector("#trendWrap"),
  trendChart: document.querySelector("#trendChart"),
  trendTip: document.querySelector("#trendTip"),
  trendEmpty: document.querySelector("#trendEmpty"),
  trendTableWrap: document.querySelector("#trendTableWrap"),
  trendTableBody: document.querySelector("#trendTableBody"),
  trendChartViewButton: document.querySelector("#trendChartViewButton"),
  trendTableViewButton: document.querySelector("#trendTableViewButton"),
  teamResolvedList: document.querySelector("#teamResolvedList"),
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
  tableNote: document.querySelector("#tableNote"),
  messageBand: document.querySelector("#messageBand"),
  messageTitle: document.querySelector("#messageTitle"),
  messageText: document.querySelector("#messageText"),
};

const SVG_NS = "http://www.w3.org/2000/svg";
const formatter = new Intl.NumberFormat("en-IN");
const DASHBOARD_TIMEOUT_MS = 90_000;
const ROW_LIMIT = 250;
const teammateLegendPageSize = 8;
const THEME_KEY = "kapture-dashboard-theme";

let currentLoadId = 0;
let currentPayload = null;
let openWorkTab = "pending";
let trendView = "chart";
let teamResolvedPage = 0;
let agentQuery = "";
const selectedAgents = new Set(["__all"]);

boot();

function boot() {
  applyStoredTheme();

  for (const input of filterInputs()) input.value = "";

  elements.themeToggle.addEventListener("click", () => toggleTheme());
  elements.dateRangeTrigger.addEventListener("click", () => toggleFilter(elements.dateRangeBlock));
  elements.agentTrigger.addEventListener("click", () => toggleFilter(elements.agentBlock));
  elements.applyCustomRange.addEventListener("click", () => applyCustomRange());
  elements.agentSearch.addEventListener("input", () => {
    agentQuery = elements.agentSearch.value.trim().toLowerCase();
    renderAgentMenu(currentPayload);
  });

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

  for (const button of [elements.trendChartViewButton, elements.trendTableViewButton]) {
    button.addEventListener("click", () => {
      trendView = button.dataset.trendView;
      renderTrend(currentPayload);
    });
  }

  document.addEventListener("click", (event) => {
    for (const block of [elements.dateRangeBlock, elements.agentBlock]) {
      if (!block.contains(event.target)) closeFilter(block);
    }
    if (!elements.exportMenu.contains(event.target)) elements.exportMenu.open = false;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeFilter(elements.dateRangeBlock);
    closeFilter(elements.agentBlock);
    elements.exportMenu.open = false;
  });

  bindTrendHover();
  observeTrendResize();

  renderEmptyState();
  setStatus("loading", "Select dates");
  showMessage("Select a date range", "Choose a date range above — the dashboard loads live Kapture data for it.");
}

/* ------------------------------------------------------------------ theme */

function applyStoredTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    stored = null;
  }
  if (stored === "dark" || stored === "light") {
    document.documentElement.dataset.theme = stored;
  }
  updateThemeIcon();
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme || systemTheme();
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage unavailable — theme still applies for this session */
  }
  updateThemeIcon();
  renderTrend(currentPayload);
  renderSparklines(currentPayload);
}

function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeIcon() {
  const dark = (document.documentElement.dataset.theme || systemTheme()) === "dark";
  elements.themeIcon.textContent = dark ? "☾" : "☀";
  elements.themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
}

/* ----------------------------------------------------------------- filters */

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

function toggleFilter(block) {
  const open = block.classList.contains("open");
  closeFilter(elements.dateRangeBlock);
  closeFilter(elements.agentBlock);
  if (open) return;
  block.classList.add("open");
  block.querySelector(".filter-menu").hidden = false;
  block.querySelector(".filter-trigger").setAttribute("aria-expanded", "true");
  block.querySelector(".filter-menu input")?.focus();
}

function closeFilter(block) {
  block.classList.remove("open");
  block.querySelector(".filter-menu").hidden = true;
  block.querySelector(".filter-trigger").setAttribute("aria-expanded", "false");
}

function chooseDateRange(rangeType) {
  const now = new Date();
  let start = now;
  let end = now;
  let label = "Selected range";

  if (rangeType === "custom") {
    elements.customDateFields.hidden = false;
    markActiveRange("custom");
    return;
  }

  elements.customDateFields.hidden = true;

  if (rangeType === "yesterday") {
    start = addDays(now, -1);
    end = addDays(now, -1);
    label = "Yesterday";
  } else if (rangeType === "week") {
    start = startOfWeek(now);
    label = "This week";
  } else if (rangeType === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    label = "This month";
  } else {
    label = "Today";
  }

  elements.startDate.value = toDateInputValue(start);
  elements.endDate.value = toDateInputValue(end);
  elements.dateRangeValue.textContent = label;
  markActiveRange(rangeType);
  closeFilter(elements.dateRangeBlock);
  loadDashboard();
}

function markActiveRange(rangeType) {
  for (const button of elements.dateRangeMenu.querySelectorAll("[data-range]")) {
    button.setAttribute("aria-pressed", String(button.dataset.range === rangeType));
  }
}

function applyCustomRange() {
  const start = datePart(elements.customStartDate.value);
  const end = datePart(elements.customEndDate.value);
  if (!start || !end) {
    showMessage("Select custom dates", "Choose both a start and an end date & time.");
    return;
  }

  elements.startDate.value = start;
  elements.endDate.value = end;
  elements.dateRangeValue.textContent = `${formatDayShort(start)} – ${formatDayShort(end)}`;
  closeFilter(elements.dateRangeBlock);
  loadDashboard();
}

/* ------------------------------------------------------------------- load */

async function loadDashboard() {
  const loadId = currentLoadId + 1;
  currentLoadId = loadId;

  if (!hasDateRange()) {
    renderEmptyState();
    setStatus("loading", "Select dates");
    showMessage("Select a date range", "Choose a date range above, then refresh.");
    return;
  }

  const params = currentParams();
  params.set("_", String(Date.now()));
  const query = params.toString();
  setStatus("loading", "Refreshing");
  hideMessage();
  document.body.classList.add("is-refreshing");
  elements.refreshButton.disabled = true;
  elements.refreshButton.innerHTML = '<span class="spin"></span>Refreshing';
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
    setStatus("live", `Live · ${formatClock(payload.fetchedAt)}`);
  } catch (error) {
    if (loadId !== currentLoadId) return;
    const message = error?.name === "AbortError"
      ? "Kapture is taking longer than expected. Refresh again — the dashboard will not stay stuck."
      : error.message;
    setStatus("error", "Data delayed");
    renderEmptyState();
    showMessage("Live data unavailable", message);
  } finally {
    if (loadId === currentLoadId) {
      document.body.classList.remove("is-refreshing");
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

/* ----------------------------------------------------------------- render */

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

  renderResolvedSplit(payload);
  updateRangeSummary(payload);
  renderSparklines(payload);
  renderAgentMenu(payload);
  // the teammate panel sets the height of the chart row, so fill it before the
  // trend chart measures its plot area
  renderTeamResolvedSummary(payload);
  renderTrend(payload);
  renderOpenWork(payload);
  renderMetricWarning(payload);
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
  renderResolvedSplit(null);
  renderSparklines(null);
  renderTrend(null);
  renderAgentMenu(null);
  renderTeamResolvedSummary(null);
  renderOpenWork(null);
}

function updateRangeSummary(payload) {
  const days = payload?.daily?.length || 0;
  const start = payload?.daily?.[0]?.date;
  const end = payload?.daily?.at(-1)?.date;
  if (!start || !end) {
    elements.rangeSummary.textContent = "Choose a date range to load live Kapture data.";
    return;
  }
  const span = start === end
    ? formatDayShort(start)
    : `${formatDayShort(start)} – ${formatDayShort(end)}`;
  elements.rangeSummary.textContent = `${span} · ${days} day${days === 1 ? "" : "s"}`;
}

/* The Resolved headline counts every ticket Kapture marks status=Complete, which
   bundles Closed and Replied together with genuine resolutions. Show the split so
   nobody reads the headline as a resolution count. */

const SUBSTATUS_CLASSES = {
  resolved: "sub-resolved",
  closed: "sub-closed",
  replied: "sub-replied",
};

function substatusClass(name) {
  return SUBSTATUS_CLASSES[String(name || "").toLowerCase()] || "sub-other";
}

function renderResolvedSplit(payload) {
  const rows = payload?.resolvedBySubstatus || [];
  const total = rows.reduce((sum, row) => sum + row.count, 0);

  if (!total) {
    elements.resolvedSplit.hidden = true;
    elements.resolvedSplitBar.replaceChildren();
    elements.resolvedSplitKeys.replaceChildren();
    elements.resolvedInfo.title = "Counts every ticket Kapture marks Complete.";
    return;
  }

  elements.resolvedSplit.hidden = false;

  const bar = rows.map((row) => {
    const seg = document.createElement("span");
    seg.className = `split-seg ${substatusClass(row.substatus)}`;
    seg.style.width = `${(row.count / total) * 100}%`;
    seg.title = `${row.substatus}: ${formatter.format(row.count)}`;
    return seg;
  });

  const keys = rows.map((row) => {
    const key = document.createElement("span");
    key.className = "split-key";

    const dot = document.createElement("span");
    dot.className = `split-dot ${substatusClass(row.substatus)}`;

    const label = document.createTextNode(`${row.substatus} `);
    const value = document.createElement("b");
    value.textContent = formatter.format(row.count);

    const share = document.createElement("span");
    share.className = "split-share";
    share.textContent = ` ${((row.count / total) * 100).toFixed(1)}%`;

    key.append(dot, label, value, share);
    return key;
  });

  elements.resolvedSplitBar.replaceChildren(...bar);
  elements.resolvedSplitKeys.replaceChildren(...keys);

  const strict = payload?.totals?.resolvedStrict ?? 0;
  elements.resolvedInfo.title =
    `Resolved counts every ticket Kapture marks Complete (${formatter.format(total)}). `
    + `Only ${formatter.format(strict)} carry substatus "Resolved" — the rest are Closed or Replied.`;
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
      `Created/Resolved are using the ticket-list fallback. ${error}`,
    );
  }
}

/* ------------------------------------------------------------- sparklines */

function renderSparklines(payload) {
  const daily = payload?.daily || [];
  renderSpark(elements.createdSpark, daily.map((row) => row.created));
  renderSpark(elements.resolvedSpark, daily.map((row) => row.resolved));
  renderSpark(elements.pendingSpark, daily.map((row) => row.pendingCreated));
  renderSpark(elements.backlogSpark, daily.map((row) => row.openBacklog));
}

function renderSpark(target, values) {
  target.replaceChildren();
  if (values.length < 2) return;

  const width = 84;
  const height = 30;
  const top = 4;
  const bottom = height - 3;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values.map((value, index) => [
    index * step,
    bottom - (value / max) * (bottom - top),
  ]);

  const line = points.map(([x, y], index) => `${index ? "L" : "M"}${round(x)} ${round(y)}`).join(" ");
  target.append(svgEl("path", {
    class: "spark-area",
    d: `${line} L${round(width)} ${height} L0 ${height} Z`,
  }));
  target.append(svgEl("path", { class: "spark-line", d: line }));

  const [endX, endY] = points.at(-1);
  target.append(svgEl("circle", { class: "spark-end", cx: round(endX - 1.5), cy: round(endY), r: 2.2 }));
}

/* ------------------------------------------------------------ trend chart */

const trendGeometry = { points: [], plot: null };
let drawRetries = 0;

function renderTrend(payload) {
  const daily = payload?.daily || [];
  const isTable = trendView === "table";

  elements.trendChartViewButton.classList.toggle("active", !isTable);
  elements.trendTableViewButton.classList.toggle("active", isTable);
  elements.trendTableWrap.hidden = !isTable;
  elements.trendWrap.parentElement.hidden = isTable;
  elements.trendWrap.hidden = isTable || !daily.length;
  elements.trendEmpty.hidden = isTable || Boolean(daily.length);

  renderTrendTable(daily);
  if (isTable || !daily.length) {
    hideTrendTip();
    return;
  }

  drawTrendChart(daily);
}

function renderTrendTable(daily) {
  elements.trendTableBody.replaceChildren();
  if (!daily.length) {
    elements.trendTableBody.append(emptyRow(5, "No daily data"));
    return;
  }
  for (const row of daily) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="date-cell">${escapeHtml(formatDayShort(row.date))}</td>
      <td class="num">${formatter.format(row.created)}</td>
      <td class="num">${formatter.format(row.resolved)}</td>
      <td class="num">${formatter.format(row.pendingCreated)}</td>
      <td class="num">${formatter.format(row.openBacklog)}</td>
    `;
    elements.trendTableBody.append(tr);
  }
}

function drawTrendChart(daily) {
  const svg = elements.trendChart;

  // Never draw into an unlaid-out box: the plot would be sized against a stale
  // coordinate space. Retry on the next frame (the resize observer also redraws).
  if (elements.trendWrap.clientWidth < 10 || elements.trendWrap.clientHeight < 10) {
    if (drawRetries < 8) {
      drawRetries += 1;
      requestAnimationFrame(() => {
        if (trendView === "chart" && currentPayload?.daily?.length) drawTrendChart(currentPayload.daily);
      });
    }
    return;
  }
  drawRetries = 0;

  // a redraw discards the hover layer, so drop the tooltip that belonged to it
  hideTrendTip();
  svg.replaceChildren();

  const width = Math.max(svg.clientWidth || elements.trendWrap.clientWidth, 320);
  const height = clamp(elements.trendWrap.clientHeight, 250, 460);
  const pad = { top: 20, right: 54, bottom: 30, left: 44 };
  const plot = {
    x: pad.left,
    y: pad.top,
    w: width - pad.left - pad.right,
    h: height - pad.top - pad.bottom,
  };

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const { max: maxValue, ticks } = axisScale(Math.max(
    ...daily.map((row) => row.created),
    ...daily.map((row) => row.resolved),
    1,
  ));

  const toY = (value) => plot.y + plot.h - (value / maxValue) * plot.h;
  const toX = daily.length === 1
    ? () => plot.x + plot.w / 2
    : (index) => plot.x + (index / (daily.length - 1)) * plot.w;

  // y grid + labels
  for (const tick of ticks) {
    const y = round(toY(tick));
    svg.append(svgEl("line", { class: "grid-line", x1: plot.x, x2: plot.x + plot.w, y1: y, y2: y }));
    svg.append(text(plot.x - 10, y + 4, formatter.format(tick), { class: "tick-text", "text-anchor": "end" }));
  }

  // baseline
  svg.append(svgEl("line", {
    class: "axis-line",
    x1: plot.x,
    x2: plot.x + plot.w,
    y1: round(plot.y + plot.h),
    y2: round(plot.y + plot.h),
  }));

  // x labels — first, last and evenly spaced middles, never crowded
  for (const index of xLabelIndexes(daily.length, plot.w)) {
    const anchor = index === 0 ? "start" : index === daily.length - 1 ? "end" : "middle";
    svg.append(text(round(toX(index)), plot.y + plot.h + 19, formatDayTick(daily[index].date), {
      class: "tick-text",
      "text-anchor": daily.length === 1 ? "middle" : anchor,
    }));
  }

  const series = [
    { key: "created", label: "Created", color: "var(--series-1)" },
    { key: "resolved", label: "Resolved", color: "var(--series-2)" },
  ];

  const points = daily.map((row, index) => ({
    date: row.date,
    x: toX(index),
    created: row.created,
    resolved: row.resolved,
    createdY: toY(row.created),
    resolvedY: toY(row.resolved),
  }));

  for (const item of series) {
    const coords = points.map((point) => [point.x, toY(point[item.key])]);
    if (coords.length === 1) {
      svg.append(svgEl("circle", {
        cx: round(coords[0][0]),
        cy: round(coords[0][1]),
        r: 4.5,
        fill: item.color,
        class: "series-end",
      }));
    } else {
      svg.append(svgEl("path", {
        class: "series-line",
        stroke: item.color,
        d: coords.map(([x, y], index) => `${index ? "L" : "M"}${round(x)} ${round(y)}`).join(" "),
      }));
      const [lastX, lastY] = coords.at(-1);
      svg.append(svgEl("circle", { class: "series-end", cx: round(lastX), cy: round(lastY), r: 4, fill: item.color }));
    }
  }

  // selective direct labels: endpoint value per series, nudged apart when close
  const endCreated = toY(daily.at(-1).created);
  const endResolved = toY(daily.at(-1).resolved);
  const gap = Math.abs(endCreated - endResolved);
  const shift = gap < 15 ? (endCreated <= endResolved ? -7 : 7) : 0;
  const endX = round(toX(daily.length - 1)) + 10;
  svg.append(text(endX, round(endCreated + shift) + 4, formatter.format(daily.at(-1).created), { class: "end-label", fill: "var(--series-1)" }));
  svg.append(text(endX, round(endResolved - shift) + 4, formatter.format(daily.at(-1).resolved), { class: "end-label", fill: "var(--series-2)" }));

  const hoverLayer = svgEl("g", { id: "trendHoverLayer" });
  svg.append(hoverLayer);
  svg.append(svgEl("rect", {
    id: "trendHitArea",
    x: plot.x,
    y: plot.y,
    width: plot.w,
    height: plot.h,
    fill: "transparent",
  }));

  trendGeometry.points = points;
  trendGeometry.plot = plot;
}

function bindTrendHover() {
  const svg = elements.trendChart;
  svg.addEventListener("pointermove", (event) => {
    if (!trendGeometry.points.length || !trendGeometry.plot) return;
    const rect = svg.getBoundingClientRect();
    const scale = (svg.viewBox.baseVal?.width || rect.width) / rect.width;
    const x = (event.clientX - rect.left) * scale;
    let nearest = trendGeometry.points[0];
    for (const point of trendGeometry.points) {
      if (Math.abs(point.x - x) < Math.abs(nearest.x - x)) nearest = point;
    }
    showTrendTip(nearest, rect, scale);
  });
  svg.addEventListener("pointerleave", () => hideTrendTip());
}

function showTrendTip(point, rect, scale) {
  const layer = elements.trendChart.querySelector("#trendHoverLayer");
  if (!layer) return;
  const plot = trendGeometry.plot;
  layer.replaceChildren();
  layer.append(svgEl("line", {
    class: "crosshair",
    x1: round(point.x),
    x2: round(point.x),
    y1: plot.y,
    y2: plot.y + plot.h,
  }));
  layer.append(svgEl("circle", { class: "hover-dot", cx: round(point.x), cy: round(point.createdY), r: 4.5, fill: "var(--series-1)" }));
  layer.append(svgEl("circle", { class: "hover-dot", cx: round(point.x), cy: round(point.resolvedY), r: 4.5, fill: "var(--series-2)" }));

  elements.trendTip.innerHTML = `
    <div class="tip-title">${escapeHtml(formatDayShort(point.date))}</div>
    <div class="tip-row"><span class="legend-key" style="background: var(--series-1)"></span>Created <b>${formatter.format(point.created)}</b></div>
    <div class="tip-row"><span class="legend-key" style="background: var(--series-2)"></span>Resolved <b>${formatter.format(point.resolved)}</b></div>
  `;
  elements.trendTip.hidden = false;

  const wrapRect = elements.trendWrap.getBoundingClientRect();
  const left = clamp(point.x / scale, 84, rect.width - 84);
  const top = Math.max(Math.min(point.createdY, point.resolvedY) / scale - 12, 8);
  elements.trendTip.style.left = `${left + (rect.left - wrapRect.left)}px`;
  elements.trendTip.style.top = `${top + (rect.top - wrapRect.top)}px`;
}

function hideTrendTip() {
  elements.trendTip.hidden = true;
  elements.trendChart.querySelector("#trendHoverLayer")?.replaceChildren();
}

function observeTrendResize() {
  if (typeof ResizeObserver !== "function") return;
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (trendView === "chart" && currentPayload?.daily?.length) drawTrendChart(currentPayload.daily);
    });
  });
  observer.observe(elements.trendWrap);
}

/* -------------------------------------------------------- teammate ranking */

function renderTeamResolvedSummary(payload) {
  elements.teamResolvedList.replaceChildren();
  const rows = selectedResolvedSummary(selectedResolvedTickets(payload));
  const total = rows.reduce((sum, row) => sum + row.resolved, 0);

  elements.teamResolvedCountLabel.textContent = `${formatter.format(rows.length)} teammate${rows.length === 1 ? "" : "s"} in this range`;
  elements.teamResolvedTotal.textContent = formatter.format(total);

  if (!rows.length) {
    elements.teamResolvedPager.hidden = true;
    const empty = document.createElement("div");
    empty.className = "empty-block";
    empty.innerHTML = "<strong>No resolved tickets</strong><span>Nothing was resolved in this range.</span>";
    elements.teamResolvedList.append(empty);
    return;
  }

  const pageCount = Math.ceil(rows.length / teammateLegendPageSize);
  teamResolvedPage = Math.min(teamResolvedPage, Math.max(pageCount - 1, 0));
  const top = rows[0].resolved || 1;
  const visibleRows = rows.slice(
    teamResolvedPage * teammateLegendPageSize,
    teamResolvedPage * teammateLegendPageSize + teammateLegendPageSize,
  );

  for (const row of visibleRows) {
    const percent = total ? (row.resolved / total) * 100 : 0;
    const item = document.createElement("div");
    item.className = "rank-row";
    item.title = `${row.teammate}: ${formatter.format(row.resolved)} resolved (${percent.toFixed(1)}%)`;
    item.innerHTML = `
      <span class="rank-name">${escapeHtml(row.teammate)}</span>
      <span class="rank-value">${formatter.format(row.resolved)}<span>${percent.toFixed(1)}%</span></span>
      <span class="rank-track"><span class="rank-fill" style="width: ${((row.resolved / top) * 100).toFixed(2)}%"></span></span>
    `;
    elements.teamResolvedList.append(item);
  }

  elements.teamResolvedPager.hidden = pageCount <= 1;
  elements.teamResolvedPageLabel.textContent = `${teamResolvedPage + 1} / ${pageCount}`;
  elements.teamResolvedPrev.disabled = teamResolvedPage === 0;
  elements.teamResolvedNext.disabled = teamResolvedPage >= pageCount - 1;
}

function changeTeamResolvedPage(delta) {
  const rows = selectedResolvedSummary(selectedResolvedTickets(currentPayload));
  const pageCount = Math.ceil(rows.length / teammateLegendPageSize);
  teamResolvedPage = Math.max(0, Math.min(teamResolvedPage + delta, Math.max(pageCount - 1, 0)));
  renderTeamResolvedSummary(currentPayload);
}

function selectedResolvedSummary(rows) {
  const map = new Map();
  for (const ticket of rows) {
    const name = ticket.completedByName || "Unassigned";
    map.set(name, (map.get(name) || 0) + 1);
  }
  return [...map.entries()]
    .map(([teammate, resolved]) => ({ teammate, resolved }))
    .sort((a, b) => b.resolved - a.resolved || a.teammate.localeCompare(b.teammate));
}

/* ------------------------------------------------------------ agent filter */

function renderAgentMenu(payload) {
  elements.agentList.replaceChildren();
  const agents = getAgents(payload);
  const visible = agentQuery
    ? agents.filter((agent) => agent.toLowerCase().includes(agentQuery))
    : agents;

  elements.agentList.append(agentCheckbox("All teammates", "__all", selectedAgents.has("__all"), true));
  for (const agent of visible) {
    elements.agentList.append(agentCheckbox(agent, agent, selectedAgents.has(agent)));
  }
  if (agents.length && !visible.length) {
    elements.agentList.append(emptyLine("No teammate matches that search"));
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
  return [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function agentCheckbox(label, value, checked, isAll = false) {
  const row = document.createElement("label");
  row.className = isAll ? "agent-check-row is-all" : "agent-check-row";
  row.innerHTML = `<input type="checkbox" value="${escapeHtml(value)}" ${checked ? "checked" : ""}><span>${escapeHtml(label)}</span>`;
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
  elements.agentValue.textContent = selected.length === 1
    ? selected[0]
    : `${selected.length} teammates selected`;
}

/* ------------------------------------------------------------ ticket table */

function renderOpenWork(payload) {
  const isResolved = openWorkTab === "resolved";
  elements.pendingTabButton.classList.toggle("active", !isResolved);
  elements.resolvedTabButton.classList.toggle("active", isResolved);
  elements.pendingPanel.hidden = isResolved;
  elements.resolvedPanel.hidden = !isResolved;

  const rows = isResolved
    ? filterTickets(selectedResolvedTickets(payload))
    : filterTickets(payload?.pendingTickets || []);

  elements.ticketDetailsTitle.textContent = isResolved ? "Resolved tickets" : "Pending tickets";
  elements.ticketDetailsCountLabel.textContent = `${formatter.format(rows.length)} ticket${rows.length === 1 ? "" : "s"}`;

  if (isResolved) renderResolvedDetails(rows);
  else renderPendingTable(rows);

  if (rows.length > ROW_LIMIT) {
    elements.tableNote.textContent = `Showing the first ${formatter.format(ROW_LIMIT)} of ${formatter.format(rows.length)} tickets — export the CSV for the full list.`;
    elements.tableNote.hidden = false;
  } else {
    elements.tableNote.hidden = true;
  }
}

function renderPendingTable(rows) {
  elements.pendingBody.replaceChildren();

  if (!rows.length) {
    elements.pendingBody.append(emptyRow(7, "No pending tickets in this range"));
    return;
  }

  for (const ticket of rows.slice(0, ROW_LIMIT)) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="ticket-id">${escapeHtml(ticket.ticketId || "-")}</span></td>
      <td class="date-cell">${escapeHtml(ticket.date || "-")}</td>
      <td>${escapeHtml(ticket.queueName || "-")}</td>
      <td>${escapeHtml(ticket.creatorName || "-")}</td>
      <td>${escapeHtml(ticket.assignedToName || "-")}</td>
      <td>${statusChip(ticket.substatus || ticket.status || "Pending", "pending")}</td>
      <td class="title-cell">${escapeHtml(ticket.taskTitle || "-")}</td>
    `;
    elements.pendingBody.append(row);
  }
}

function renderResolvedDetails(rows) {
  elements.resolvedDetailsBody.replaceChildren();

  if (!rows.length) {
    elements.resolvedDetailsBody.append(emptyRow(7, "No resolved tickets in this range"));
    return;
  }

  for (const ticket of rows.slice(0, ROW_LIMIT)) {
    const name = ticket.completedByName || "Unassigned";
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="ticket-id">${escapeHtml(ticket.ticketId || "-")}</span></td>
      <td class="date-cell">${escapeHtml(ticket.taskEnddate || "-")}</td>
      <td><span class="person-name"><span class="avatar" aria-hidden="true">${escapeHtml(initials(name))}</span>${escapeHtml(name)}</span></td>
      <td><span class="priority-chip">${escapeHtml(ticket.priorityName || "No priority")}</span></td>
      <td>${escapeHtml(ticket.queueName || "-")}</td>
      <td>${statusChip(ticket.substatus || ticket.status || "Resolved", "resolved")}</td>
      <td class="title-cell">${escapeHtml(ticket.taskTitle || "-")}</td>
    `;
    elements.resolvedDetailsBody.append(row);
  }
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

function statusChip(label, tone) {
  return `<span class="status-chip ${tone}">${escapeHtml(label)}</span>`;
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts.at(-1)[0] : "")).toUpperCase();
}

/* --------------------------------------------------------------- messaging */

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

/* --------------------------------------------------------------- utilities */

function svgEl(name, attributes) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function text(x, y, value, attributes = {}) {
  const node = svgEl("text", { x, y, ...attributes });
  node.textContent = value;
  return node;
}

function emptyRow(span, label) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.className = "empty-cell";
  cell.colSpan = span;
  cell.textContent = label;
  row.append(cell);
  return row;
}

function emptyLine(label) {
  const node = document.createElement("p");
  node.className = "muted";
  node.style.padding = "10px";
  node.style.fontSize = "12.5px";
  node.textContent = label;
  return node;
}

// Four intervals of a round step, so every gridline label is a whole number.
function axisScale(dataMax) {
  const intervals = 4;
  const rough = Math.max(dataMax, 1) / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
    .map((factor) => factor * magnitude)
    .find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const rounded = Math.max(1, Math.round(step)); // ticket counts are whole numbers
  return {
    max: rounded * intervals,
    ticks: Array.from({ length: intervals + 1 }, (_, index) => rounded * index),
  };
}

function xLabelIndexes(length, plotWidth) {
  if (length <= 1) return [0];
  const maxLabels = Math.max(2, Math.floor(plotWidth / 74));
  if (length <= maxLabels) return Array.from({ length }, (_, index) => index);
  const stride = Math.ceil((length - 1) / (maxLabels - 1));
  const indexes = new Set([0, length - 1]);
  // keep a clear stride away from both ends so first/last labels never collide
  for (let index = stride; index <= length - 1 - Math.ceil(stride * 0.6); index += stride) {
    indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}

function formatDayShort(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  return date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

function formatDayTick(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
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

function round(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
