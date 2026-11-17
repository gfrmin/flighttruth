const form = document.getElementById('search-form');
const resultsSection = document.getElementById('results');
const summaryEl = document.getElementById('summary');
const aircraftPanel = document.getElementById('aircraft-panel');
const flightPanel = document.getElementById('flight-panel');
const sourcesTable = document.getElementById('sources-table');
const errorEl = document.getElementById('error');
const refreshBtn = document.getElementById('refresh-btn');
const routeForm = document.getElementById('route-form');
const routeResultsEl = document.getElementById('route-results');
const routeErrorEl = document.getElementById('route-error');

const AIRCRAFT_FIELDS = ['aircraftType', 'tailNumber', 'age', 'seatConfiguration'];

let lastQuery = null;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const type = form.elements['type'].value;
  const query = document.getElementById('query').value.trim();
  const date = document.getElementById('date').value;
  lastQuery = { type, query, date };
  await runLookup(false);
});

refreshBtn.addEventListener('click', () => runLookup(true));

async function runLookup(refresh) {
  if (!lastQuery) return;
  errorEl.hidden = true;
  resultsSection.hidden = true;

  const params = new URLSearchParams({ ...lastQuery, refresh: String(refresh) });
  const res = await fetch(`/api/flight?${params}`);
  const data = await res.json();

  if (!res.ok) {
    errorEl.textContent = data.error ?? 'Lookup failed';
    errorEl.hidden = false;
    return;
  }

  render(data);
}

function render(data) {
  const distByField = Object.fromEntries(data.distributions.map((d) => [d.field, d]));

  summaryEl.innerHTML =
    `<strong>${escapeHtml(lastQuery.query.toUpperCase())}</strong> — ${escapeHtml(lastQuery.date)}` +
    renderCodeshareNote(data);

  const flightFields = data.distributions.filter((d) => !AIRCRAFT_FIELDS.includes(d.field) && d.values.length > 0);
  flightPanel.innerHTML = flightFields.length
    ? flightFields.map((d) => renderFieldBars(d.field, d)).join('')
    : '<p class="empty">No source has schedule or status data</p>';
  aircraftPanel.innerHTML = AIRCRAFT_FIELDS.map((field) => renderFieldBars(field, distByField[field])).join('');

  const allSourceIds = data.sourceResults.map((r) => r.source);
  const fieldNames = data.distributions.map((d) => d.field);
  sourcesTable.innerHTML = renderSourcesTable(allSourceIds, fieldNames, data.sourceResults);

  resultsSection.hidden = false;
}

function renderCodeshareNote(data) {
  const notes = [];
  if (data.resolvedOperatingFlightNumber) {
    notes.push(`live tracking resolved via operating flight <strong>${escapeHtml(data.resolvedOperatingFlightNumber)}</strong>`);
  }
  if (data.codeshareFlightNumbers?.length) {
    notes.push(`also tracked as ${data.codeshareFlightNumbers.map(escapeHtml).join(', ')}`);
  }
  return notes.length ? `<p class="codeshare-note">${notes.join(' · ')}</p>` : '';
}

function renderFieldBars(field, distribution) {
  if (!distribution || distribution.values.length === 0) {
    return `<div class="field-row"><h3>${field}</h3><p class="empty">No data from any source</p></div>`;
  }
  const bars = distribution.values
    .map((v) => `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(v.value)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(v.weight * 100)}%"></div></div>
        <span class="bar-pct">${Math.round(v.weight * 100)}% (${escapeHtml(v.sources.join(', '))})</span>
      </div>`)
    .join('');
  const flags = [
    distribution.unconfirmed ? '<span class="flag">unconfirmed — single source</span>' : '',
    distribution.paywalledAt.length ? `<span class="flag paywall">paywalled at: ${escapeHtml(distribution.paywalledAt.join(', '))}</span>` : '',
  ].join(' ');
  return `<div class="field-row"><h3>${field}</h3>${bars}<div class="flags">${flags}</div></div>`;
}

function renderSourcesTable(sourceIds, fieldNames, sourceResults) {
  const bySource = Object.fromEntries(sourceResults.map((r) => [r.source, r]));
  const header = `<tr><th>Source</th>${fieldNames.map((f) => `<th>${f}</th>`).join('')}</tr>`;
  const rows = sourceIds
    .map((id) => {
      const result = bySource[id];
      if (result.error) {
        return `<tr><td>${id}</td><td colspan="${fieldNames.length}" class="source-error">unavailable: ${escapeHtml(result.error)}</td></tr>`;
      }
      const cells = fieldNames
        .map((f) => {
          const fv = result.fields[f];
          if (!fv) return '<td>—</td>';
          if (fv.paywalled) return '<td class="paywalled">paywalled</td>';
          return `<td>${escapeHtml(fv.value ?? '—')}</td>`;
        })
        .join('');
      const label = result.retriedAs
        ? `${escapeHtml(id)} <span class="hint">(as ${escapeHtml(result.retriedAs)})</span>`
        : escapeHtml(id);
      return `<tr><td>${label}</td>${cells}</tr>`;
    })
    .join('');
  return header + rows;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

routeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  routeErrorEl.hidden = true;
  routeResultsEl.hidden = true;

  const params = new URLSearchParams({
    origin: document.getElementById('route-origin').value.trim(),
    destination: document.getElementById('route-destination').value.trim(),
    date: document.getElementById('route-date').value,
  });
  const res = await fetch(`/api/routes?${params}`);
  const data = await res.json();

  if (!res.ok) {
    routeErrorEl.textContent = data.error ?? 'Route search failed';
    routeErrorEl.hidden = false;
    return;
  }

  renderRouteCandidates(data);
});

function renderRouteCandidates(data) {
  routeResultsEl.innerHTML = data.candidates.length === 0
    ? '<li class="empty">No flights found for this route/date.</li>'
    : data.candidates.map((c) => `
        <li class="route-candidate">
          <button type="button" class="use-flight-number" data-flight="${escapeHtml(c.flightNumber)}">
            ${escapeHtml(c.flightNumber)} — ${escapeHtml(c.airline)}
          </button>
          ${c.scheduledDeparture ? `<span>${escapeHtml(c.scheduledDeparture)}</span>` : ''}
          ${c.codeshareFlightNumbers?.length ? `<span class="hint">also: ${c.codeshareFlightNumbers.map(escapeHtml).join(', ')}</span>` : ''}
        </li>`).join('');
  routeResultsEl.hidden = false;
}

routeResultsEl.addEventListener('click', (event) => {
  const btn = event.target.closest('.use-flight-number');
  if (!btn) return;
  document.getElementById('query').value = btn.dataset.flight;
  document.querySelector('input[name="type"][value="number"]').checked = true;
  document.getElementById('date').value = document.getElementById('route-date').value;
});
