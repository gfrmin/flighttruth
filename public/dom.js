// Tiny element builder shared by the pages: el('div', { class: 'x' }, 'text', child, ...).
// Attributes that are null or undefined are left off.
export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  Object.entries(attrs)
    .filter(([, v]) => v != null)
    .forEach(([k, v]) => (k === 'class' ? (node.className = v) : node.setAttribute(k, v)));
  children.flat().forEach((c) => node.append(c instanceof Node ? c : document.createTextNode(c ?? '')));
  return node;
};

/**
 * fetch that reports a failure in the page's #load-error banner instead of throwing: resolves to
 * the Response when it is ok (clearing the banner), else null. `quietStatuses` are answers the
 * caller handles itself (a 404 for a deleted trip), returned without a banner.
 */
export async function fetchOrReport(url, options = {}, quietStatuses = [], describe = (s) => `HTTP ${s}`) {
  const banner = document.getElementById('load-error');
  const show = (text) => { if (banner) { banner.textContent = text; banner.hidden = !text; } };
  try {
    const res = await fetch(url, options);
    if (res.ok || quietStatuses.includes(res.status)) { show(''); return res; }
    show(describe(res.status));
  } catch {
    show(describe(null));
  }
  return null;
}
