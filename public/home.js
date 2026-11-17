import { headline, unreachable } from './tripText.js';
import { el, fetchOrReport } from './dom.js';

const shortDate = (iso) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

const firstDate = (trip) => trip.legs[0]?.date ?? '';

function tripCard(trip, now) {
  const { line, detail } = headline(trip.lastView, now);
  const dates = [...new Set(trip.legs.map((l) => shortDate(l.date)))].join(', ');
  return el('li', {},
    el('a', { class: 'trip-card', href: `/trips.html?id=${trip.id}` },
      el('span', { class: 'trip-card-label' }, trip.label),
      el('span', { class: 'trip-card-line' }, line),
      detail ? el('span', { class: 'trip-card-detail' }, detail) : '',
      el('span', { class: 'trip-card-legs' }, `${trip.legs.map((l) => l.flightNumber).join(' ')} · ${dates}`)));
}

async function showTrips() {
  const res = await fetchOrReport('/api/trips', {}, [], unreachable);
  if (!res) return;
  const trips = await res.json();
  const now = new Date();
  const active = trips.filter((t) => t.active).sort((a, b) => firstDate(a).localeCompare(firstDate(b)));
  const past = trips.filter((t) => !t.active);
  document.getElementById('active-trips').replaceChildren(...active.map((t) => tripCard(t, now)));
  document.getElementById('no-trips').hidden = trips.length > 0;
  document.getElementById('past-trips').replaceChildren(...past.map((t) => tripCard(t, now)));
  document.getElementById('past').hidden = past.length === 0;
}

document.getElementById('add-trip').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('add-error');
  errorEl.hidden = true;
  const res = await fetch('/api/trips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: document.getElementById('trip-input').value, label: document.getElementById('trip-label').value }),
  });
  const body = await res.json();
  if (!res.ok) {
    errorEl.textContent = body.error;
    errorEl.hidden = false;
    return;
  }
  location.href = `/trips.html?id=${body.id}`;
});

showTrips();
setInterval(showTrips, 60_000);
