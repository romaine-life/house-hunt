import { CONFIG } from './config.js';
import { initAuth, login, logout, getToken, getUser, isAuthenticated } from './auth.js';

// ── State ──────────────────────────────────────────────────
let map;
let datasource;
let popup;
let markers = new Map(); // id → atlas.Shape
let previewMarker = null;
let data = { properties: [], checklistSchema: [] };
let lastKnownVersion = null;
let isAdmin = false;
let editingId = null; // null = adding, string = editing
let showStarredOnly = false;
let selectionMode = false;
let selectionLocked = false; // button toggle vs shift-hold
let selectedIds = new Set();

// ── Status colors (Catppuccin) ─────────────────────────────
const STATUS_COLORS = {
  interested: '#89b4fa',
  visited:    '#f9e2af',
  offer:      '#a6e3a1',
  rejected:   '#f38ba8',
  closed:     '#585b70',
};

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  await loadProperties();
  renderProperties();

  const authed = await initAuth();
  if (authed) {
    const user = getUser();
    isAdmin = user?.role === 'admin';
    document.getElementById('login-btn').classList.add('hidden');
    document.getElementById('user-name').textContent = user?.name || user?.email || '';
    document.getElementById('user-name').classList.remove('hidden');
    document.getElementById('logout-btn').classList.remove('hidden');
    if (isAdmin) {
      document.getElementById('add-btn').classList.remove('hidden');
      document.getElementById('select-mode-btn').classList.remove('hidden');
    }
  }

  if (data.properties.length > 0) {
    document.getElementById('sidebar').classList.remove('collapsed');
  }

  bindEvents();
});

// ── Map ────────────────────────────────────────────────────
function initMap() {
  map = new atlas.Map('map', {
    center: [-122.68, 45.52], // Portland [lng, lat]
    zoom: 10,
    style: 'night',
    showZoomControl: true,
    authOptions: {
      authType: 'anonymous',
      clientId: CONFIG.mapsClientId,
      getToken: async (resolve, reject) => {
        try {
          const res = await fetch(`${CONFIG.apiUrl}/maps/token`);
          if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
          const { token } = await res.json();
          resolve(token);
        } catch (err) {
          reject(err);
        }
      },
    },
  });

  map.events.add('ready', async () => {
    datasource = new atlas.source.DataSource();
    map.sources.add(datasource);

    // Create pin icons for each status color — await all before adding layers
    function drawPin(color, selected) {
      const canvas = document.createElement('canvas');
      const s = 2; // scale for retina
      canvas.width = 24 * s;
      canvas.height = 36 * s;
      const ctx = canvas.getContext('2d');
      ctx.scale(s, s);
      // Pin shape
      ctx.beginPath();
      ctx.moveTo(12, 36);
      ctx.bezierCurveTo(12, 36, 0, 22, 0, 13);
      ctx.arc(12, 13, 12, Math.PI, 0, false);
      ctx.bezierCurveTo(24, 22, 12, 36, 12, 36);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = selected ? '#cdd6f4' : '#11111b';
      ctx.lineWidth = selected ? 3 : 2;
      ctx.stroke();
      // Inner dot
      ctx.beginPath();
      ctx.arc(12, 13, 5, 0, Math.PI * 2);
      ctx.fillStyle = selected ? 'rgba(205,214,244,0.5)' : 'rgba(17,17,27,0.3)';
      ctx.fill();
      return canvas.toDataURL();
    }

    const iconPromises = Object.entries(STATUS_COLORS).flatMap(([status, color]) => [
      map.imageSprite.add(`pin-${status}`, drawPin(color, false)),
      map.imageSprite.add(`pin-selected-${status}`, drawPin(color, true)),
    ]);
    await Promise.all(iconPromises);

    // Symbol layer — fixed pixel size regardless of zoom
    const pinLayer = new atlas.layer.SymbolLayer(datasource, null, {
      iconOptions: {
        image: ['concat', 'pin-', ['case', ['get', 'selected'], 'selected-', ''], ['get', 'status']],
        size: 0.5,
        anchor: 'bottom',
        allowOverlap: true,
        ignorePlacement: true,
      },
      textOptions: {
        textField: ['get', 'shortAddress'],
        offset: [0, 0.5],
        size: 12,
        color: '#cdd6f4',
        haloColor: '#11111b',
        haloWidth: 1.5,
        anchor: 'top',
        allowOverlap: true,
      },
    });

    map.layers.add(pinLayer);

    // Popup on click
    popup = new atlas.Popup({ closeButton: true, pixelOffset: [0, -32] });

    let pinClicked = false;

    map.events.add('click', pinLayer, (e) => {
      if (selectionMode) {
        // In selection mode, click pin to toggle selection
        if (e.shapes?.length > 0) {
          pinClicked = true;
          const id = e.shapes[0].getProperties().id;
          if (selectedIds.has(id)) selectedIds.delete(id);
          else selectedIds.add(id);
          renderProperties();
        }
        return;
      }
      if (e.shapes?.length > 0) {
        pinClicked = true;
        const shape = e.shapes[0];
        const props = shape.getProperties();
        const coords = shape.getCoordinates();
        popup.setOptions({
          position: coords,
          content: buildPopup(props),
        });
        popup.open(map);
        highlightCard(props.id);
      }
    });

    // Click on empty map area closes popup
    map.events.add('click', () => {
      if (pinClicked) {
        pinClicked = false;
        return;
      }
      if (selectionMode) return;
      if (popup.isOpen()) {
        popup.close();
      }
    });

    map.events.add('mousemove', pinLayer, () => {
      if (!selectionMode) map.getCanvasContainer().style.cursor = 'pointer';
    });
    map.events.add('mouseleave', pinLayer, () => {
      if (!selectionMode) map.getCanvasContainer().style.cursor = '';
    });

    // ── Rectangle drag-select ──────────────────────────────
    initRectangleSelect();

    // Re-render properties in case data loaded before the map was ready
    renderProperties();
  });
}

function buildPopup(props) {
  const statusColor = STATUS_COLORS[props.status] || '#cdd6f4';
  let html = `<div style="font-family:'Segoe UI',system-ui,sans-serif;color:#cdd6f4;background:#181825;border-radius:6px;min-width:200px;max-width:300px;overflow:hidden;">`;
  if (props.photoUrl) {
    html += `<img src="${esc(props.photoUrl)}" style="width:100%;height:140px;object-fit:cover;display:block;" />`;
  }
  html += `<div style="padding:10px 12px;">`;
  const starred = props.starred === true;
  const starColor = starred ? '#f9e2af' : '#45475a';
  const starOnClick = isAdmin ? `onclick="popupToggleStar('${props.id}')"` : '';
  html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">`;
  html += `<span style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:${statusColor};">${props.status}</span>`;
  html += `<span ${starOnClick} style="font-size:22px;color:${starColor};${isAdmin ? 'cursor:pointer;' : ''}line-height:1;" title="${starred ? 'Unstar' : 'Star'}">${starred ? '\u2605' : '\u2606'}</span>`;
  html += `</div>`;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(props.address)}`;
  html += `<a href="${mapsUrl}" target="_blank" style="font-size:14px;font-weight:600;margin-bottom:6px;display:block;color:#89b4fa;text-decoration:none;">${esc(props.address)}</a>`;

  if (props.notes) {
    const notesHtml = esc(props.notes).replace(/MLS#\s*(\d+)/g, (match, id) =>
      `<a href="https://www.google.com/search?q=${encodeURIComponent(props.address + ' MLS ' + id)}" target="_blank" rel="noopener" style="color:#89b4fa;">${match}</a>`
    );
    html += `<div style="font-size:12px;color:#a6adc8;margin-bottom:6px;white-space:pre-wrap;">${notesHtml}</div>`;
  }

  if (props.vernoniaCommuteMin) {
    html += `<div style="font-size:12px;color:#94e2d5;margin-bottom:6px;">&#x1F697; ${props.vernoniaDistanceMi} mi / ${props.vernoniaCommuteMin} min to Vernonia</div>`;
  }

  const schema = data.checklistSchema;
  if (schema.length > 0) {
    html += '<ul style="list-style:none;font-size:12px;margin-bottom:6px;padding:0;">';
    for (const item of schema) {
      const val = props.checklist?.[item.key];
      // Tri-state: null/undefined = unset (?), true = yes (✓), false = no (✗)
      const icon = val === true ? '\u2705' : val === false ? '\u274C' : '\u2754';
      const onClick = isAdmin ? `onclick="popupCycleCheck('${props.id}','${item.key}')"` : '';
      html += `<li style="padding:2px 0;display:flex;align-items:center;gap:6px;${isAdmin ? 'cursor:pointer;' : ''}" ${onClick}>`;
      html += `<span style="font-size:14px;line-height:1;">${icon}</span>`;
      html += `<span style="color:${val === true ? '#a6e3a1' : val === false ? '#f38ba8' : '#6c7086'};">${esc(item.label)}</span></li>`;
    }
    html += '</ul>';
  }

  if (props.listingUrl) {
    html += `<div style="font-size:12px;"><a href="${esc(props.listingUrl)}" target="_blank" rel="noopener" style="color:#89b4fa;">View listing</a></div>`;
  }

  if (isAdmin) {
    html += `<div style="margin-top:8px;display:flex;gap:8px;">`;
    html += `<button onclick="popupEdit('${props.id}')" style="flex:1;padding:4px 8px;font-size:11px;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:4px;cursor:pointer;">Edit</button>`;
    html += `<button onclick="popupDelete('${props.id}')" style="padding:4px 8px;font-size:11px;background:transparent;color:#f38ba8;border:1px solid #f38ba8;border-radius:4px;cursor:pointer;">Delete</button>`;
    html += `</div>`;
  }

  html += '</div></div>';
  return html;
}

function fitMapToData() {
  if (datasource.getShapes().length === 0) return;
  const bounds = atlas.data.BoundingBox.fromData(datasource.toJson());
  map.setCamera({ bounds, padding: 50, maxZoom: 14 });
}

// ── Data ───────────────────────────────────────────────────
async function loadProperties() {
  try {
    const res = await fetch(`${CONFIG.apiUrl}/api/properties`);
    if (!res.ok) {
      console.warn('Failed to load properties:', res.status);
      return;
    }
    const json = await res.json();
    data.properties = json.properties || [];
    data.checklistSchema = json.checklistSchema || [];
    lastKnownVersion = json.updatedAt || null;
  } catch (err) {
    console.warn('Could not reach API, using empty data:', err.message);
  }
}

async function saveProperty(prop) {
  const isNew = !editingId;

  if (isNew) {
    data.properties.push(prop);
  } else {
    const idx = data.properties.findIndex(p => p.id === editingId);
    if (idx !== -1) data.properties[idx] = prop;
  }

  try {
    const method = isNew ? 'POST' : 'PUT';
    const url = isNew
      ? `${CONFIG.apiUrl}/api/properties`
      : `${CONFIG.apiUrl}/api/properties/${editingId}`;

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ property: prop, lastKnownVersion }),
    });

    if (res.ok) {
      const json = await res.json();
      lastKnownVersion = json.updatedAt || lastKnownVersion;
      if (isNew && json.property?.id) {
        prop.id = json.property.id;
      }
    } else {
      console.error('Save failed:', res.status);
    }
  } catch (err) {
    console.error('Save error:', err.message);
  }

  renderProperties();
}

// Called from popup buttons
// Expose popup handlers globally for inline onclick in popup HTML
window.popupEdit = popupEdit;
window.popupDelete = popupDelete;
window.popupToggleStar = popupToggleStar;
window.popupCycleCheck = popupCycleCheck;

function popupEdit(id) {
  popup.close();
  const prop = data.properties.find(p => p.id === id);
  if (prop) editProperty(prop);
}

async function popupCycleCheck(id, key) {
  const prop = data.properties.find(p => p.id === id);
  if (!prop) return;
  if (!prop.checklist) prop.checklist = {};
  // Cycle: null/undefined → true → false → null
  const cur = prop.checklist[key];
  prop.checklist[key] = cur === null || cur === undefined ? true : cur === true ? false : null;
  try {
    const res = await fetch(`${CONFIG.apiUrl}/api/properties/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ property: prop, lastKnownVersion }),
    });
    if (res.ok) {
      const json = await res.json();
      lastKnownVersion = json.updatedAt || lastKnownVersion;
    }
  } catch (err) {
    console.error('Checklist update error:', err.message);
  }
  // Refresh popup content inline
  popup.setOptions({ content: buildPopup(prop) });
  renderProperties();
}

async function popupToggleStar(id) {
  const prop = data.properties.find(p => p.id === id);
  if (!prop) return;
  prop.starred = !prop.starred;
  try {
    const res = await fetch(`${CONFIG.apiUrl}/api/properties/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ property: prop, lastKnownVersion }),
    });
    if (res.ok) {
      const json = await res.json();
      lastKnownVersion = json.updatedAt || lastKnownVersion;
    }
  } catch (err) {
    console.error('Star toggle error:', err.message);
  }
  // Refresh popup content
  const coords = popup.getOptions().position;
  popup.setOptions({ content: buildPopup(prop) });
  renderProperties();
}

function popupDelete(id) {
  if (!confirm('Delete this property?')) return;
  popup.close();
  deleteProperty(id);
}

async function deleteProperty(id) {
  data.properties = data.properties.filter(p => p.id !== id);

  try {
    const res = await fetch(`${CONFIG.apiUrl}/api/properties/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ lastKnownVersion }),
    });
    if (res.ok) {
      const json = await res.json();
      lastKnownVersion = json.updatedAt || lastKnownVersion;
    }
  } catch (err) {
    console.error('Delete error:', err.message);
  }

  renderProperties();
}

// ── Render ─────────────────────────────────────────────────
function renderProperties() {
  const filtered = showStarredOnly ? data.properties.filter(p => p.starred) : data.properties;

  // Update map datasource
  if (datasource) {
    datasource.clear();
    for (const prop of filtered) {
      const feature = new atlas.data.Feature(
        new atlas.data.Point([prop.lng, prop.lat]),
        {
          id: prop.id,
          address: prop.address,
          shortAddress: prop.address.split(',')[0],
          notes: prop.notes,
          status: prop.status,
          starred: prop.starred,
          checklist: prop.checklist,
          listingUrl: prop.listingUrl,
          photoUrl: prop.photoUrl,
          vernoniaDistanceMi: prop.vernoniaDistanceMi,
          vernoniaCommuteMin: prop.vernoniaCommuteMin,
          color: STATUS_COLORS[prop.status] || STATUS_COLORS.interested,
          selected: selectedIds.has(prop.id),
        },
      );
      datasource.add(feature);
    }
    if (!window._initialFitDone) {
      fitMapToData();
      window._initialFitDone = true;
    }
  }

  // Selection bar
  const selBar = document.getElementById('selection-bar');
  if (selBar) {
    if (selectedIds.size > 0) {
      selBar.classList.remove('hidden');
      document.getElementById('selection-count').textContent = `${selectedIds.size} selected`;
    } else {
      selBar.classList.add('hidden');
    }
  }

  // Star filter toggle
  const starToggle = document.getElementById('star-filter');
  if (starToggle) {
    starToggle.style.color = showStarredOnly ? '#f9e2af' : '#6c7086';
    starToggle.textContent = showStarredOnly ? '\u2605 Starred' : '\u2606 All';
  }

  // Sidebar list
  const container = document.getElementById('properties');
  container.innerHTML = '';

  if (filtered.length === 0) {
    container.innerHTML = '<p style="color:var(--subtext0);font-size:13px;">No properties yet.</p>';
    return;
  }

  const hasSelection = selectedIds.size > 0;
  for (const prop of filtered) {
    const card = document.createElement('div');
    card.className = 'property-card' + (selectedIds.has(prop.id) ? ' selected' : '');
    card.dataset.id = prop.id;
    const starIcon = prop.starred ? '\u2605' : '';
    const checkHtml = (selectionMode || hasSelection) && isAdmin
      ? `<input type="checkbox" class="select-check" ${selectedIds.has(prop.id) ? 'checked' : ''} />`
      : '';
    card.innerHTML = `
      <div class="address" style="display:flex;align-items:center;">${checkHtml}${starIcon ? `<span style="color:#f9e2af;margin-right:4px;">${starIcon}</span>` : ''}${esc(prop.address)}</div>
      <div class="meta">
        <span class="status-dot ${prop.status}"></span>
        <span>${prop.status}</span>
      </div>
    `;
    card.addEventListener('click', (e) => {
      // If clicking checkbox or in selection mode, toggle selection
      if (e.target.classList.contains('select-check') || (selectionMode && isAdmin)) {
        e.preventDefault();
        if (selectedIds.has(prop.id)) selectedIds.delete(prop.id);
        else selectedIds.add(prop.id);
        renderProperties();
        return;
      }
      map.setCamera({ center: [prop.lng, prop.lat] });
      popup.setOptions({
        position: [prop.lng, prop.lat],
        content: buildPopup(prop),
      });
      popup.open(map);
      if (isAdmin) openEditForm(prop);
    });
    container.appendChild(card);
  }
}

function highlightCard(id) {
  document.querySelectorAll('.property-card').forEach(c => {
    c.style.borderLeft = c.dataset.id === id ? '3px solid var(--blue)' : '';
  });
}

// ── Form ───────────────────────────────────────────────────
function openAddForm() {
  editingId = null;
  document.getElementById('form-title').textContent = 'Add Property';
  document.getElementById('form-rmls').value = '';
  document.getElementById('form-address').value = '';
  pendingPhotoUrl = null;
  document.getElementById('form-status').value = 'interested';
  document.getElementById('form-url').value = '';
  document.getElementById('form-notes').value = '';
  document.getElementById('delete-btn').classList.add('hidden');
  renderChecklistForm({});
  showForm();
}

function openEditForm(prop) {
  editingId = prop.id;
  document.getElementById('form-title').textContent = 'Edit Property';
  document.getElementById('form-address').value = prop.address;
  document.getElementById('form-status').value = prop.status;
  document.getElementById('form-url').value = prop.listingUrl || '';
  document.getElementById('form-notes').value = prop.notes || '';
  document.getElementById('delete-btn').classList.remove('hidden');
  renderChecklistForm(prop.checklist || {});
  showForm();
}

function showForm() {
  document.getElementById('property-list').classList.add('hidden');
  document.getElementById('property-form').classList.remove('hidden');
  document.getElementById('sidebar').classList.remove('collapsed');
}

function hideForm() {
  document.getElementById('property-form').classList.add('hidden');
  document.getElementById('property-list').classList.remove('hidden');
  clearPreviewMarker();
  editingId = null;
}

function renderChecklistForm(values) {
  const container = document.getElementById('form-checklist');
  container.innerHTML = '<legend>Checklist</legend>';

  for (const item of data.checklistSchema) {
    const div = document.createElement('div');
    div.className = 'checklist-item';
    const val = values[item.key];
    const icon = val === true ? '\u2705' : val === false ? '\u274C' : '\u2754';
    const btn = document.createElement('span');
    btn.textContent = icon;
    btn.dataset.key = item.key;
    btn.dataset.state = val === true ? 'true' : val === false ? 'false' : 'null';
    btn.style.cssText = 'font-size:16px;cursor:pointer;line-height:1;';
    btn.addEventListener('click', () => {
      const cur = btn.dataset.state;
      const next = cur === 'null' ? 'true' : cur === 'true' ? 'false' : 'null';
      btn.dataset.state = next;
      btn.textContent = next === 'true' ? '\u2705' : next === 'false' ? '\u274C' : '\u2754';
    });
    const label = document.createElement('label');
    label.textContent = item.label;
    label.style.cursor = 'pointer';
    label.addEventListener('click', () => btn.click());
    div.appendChild(btn);
    div.appendChild(label);
    container.appendChild(div);
  }
}

function readFormData() {
  const checklist = {};
  document.querySelectorAll('#form-checklist span[data-key]').forEach(btn => {
    const s = btn.dataset.state;
    checklist[btn.dataset.key] = s === 'true' ? true : s === 'false' ? false : null;
  });

  const existing = editingId ? data.properties.find(p => p.id === editingId) : null;

  return {
    id: editingId || crypto.randomUUID(),
    address: document.getElementById('form-address').value.trim(),
    lat: existing?.lat || previewMarkerPos?.lat || 0,
    lng: existing?.lng || previewMarkerPos?.lng || 0,
    notes: document.getElementById('form-notes').value.trim(),
    checklist,
    status: document.getElementById('form-status').value,
    listingUrl: document.getElementById('form-url').value.trim(),
    photoUrl: pendingPhotoUrl || existing?.photoUrl || null,
    addedAt: existing?.addedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ── Geocoding (Azure Maps Search API) ──────────────────────
let previewMarkerPos = null;
let pendingPhotoUrl = null;

async function geocodeAddress(address) {
  const url = `https://atlas.microsoft.com/search/address/json?api-version=1.0&query=${encodeURIComponent(address)}`;
  try {
    // Use the map's auth to make the request
    const tokenRes = await fetch(`${CONFIG.apiUrl}/maps/token`);
    const { token } = await tokenRes.json();
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-ms-client-id': CONFIG.mapsClientId,
      },
    });
    const json = await res.json();
    if (!json.results?.length) return null;
    const pos = json.results[0].position;
    return { lat: pos.lat, lng: pos.lon };
  } catch (err) {
    console.error('Geocode error:', err);
    return null;
  }
}

function setPreviewMarker(lat, lng) {
  clearPreviewMarker();
  previewMarkerPos = { lat, lng };
  if (datasource) {
    previewMarker = new atlas.data.Feature(
      new atlas.data.Point([lng, lat]),
      { status: 'interested', shortAddress: '', id: '__preview' },
    );
    datasource.add(previewMarker);
  }
  map.setCamera({ center: [lng, lat], zoom: 15 });
}

function clearPreviewMarker() {
  if (previewMarker && datasource) {
    datasource.remove(previewMarker);
  }
  previewMarker = null;
  previewMarkerPos = null;
}

// ── Selection mode ─────────────────────────────────────────
function enterSelectionMode() {
  if (selectionMode) return;
  selectionMode = true;
  map.setUserInteraction({ dragPanInteraction: false, boxZoomInteraction: false, dragRotateInteraction: false });
  map.getCanvasContainer().style.cursor = 'crosshair';
  document.getElementById('select-mode-btn').classList.add('active');
}

function exitSelectionMode() {
  if (!selectionMode) return;
  selectionMode = false;
  map.setUserInteraction({ dragPanInteraction: true, boxZoomInteraction: true, dragRotateInteraction: true });
  map.getCanvasContainer().style.cursor = '';
  document.getElementById('select-mode-btn').classList.remove('active');
}

function initRectangleSelect() {
  const container = map.getCanvasContainer();
  const rectEl = document.getElementById('select-rect');
  let dragging = false;
  let startX = 0, startY = 0;

  container.addEventListener('mousedown', (e) => {
    if (!selectionMode || e.button !== 0) return;
    const rect = container.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    dragging = true;
    rectEl.style.left = (e.clientX) + 'px';
    rectEl.style.top = (e.clientY) + 'px';
    rectEl.style.width = '0';
    rectEl.style.height = '0';
    rectEl.classList.remove('hidden');
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top;
    const left = Math.min(startX, curX) + rect.left;
    const top = Math.min(startY, curY) + rect.top;
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);
    rectEl.style.left = left + 'px';
    rectEl.style.top = top + 'px';
    rectEl.style.width = w + 'px';
    rectEl.style.height = h + 'px';
  });

  document.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    rectEl.classList.add('hidden');

    const rect = container.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;
    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);

    // Ignore tiny drags (just a click)
    if (maxX - minX < 5 && maxY - minY < 5) return;

    // Hit test: which properties fall inside the rectangle?
    const filtered = showStarredOnly ? data.properties.filter(p => p.starred) : data.properties;
    const positions = filtered.map(p => [p.lng, p.lat]);
    if (positions.length === 0) return;

    const pixels = map.positionsToPixels(positions);

    // If not holding shift with the button toggle, replace selection
    if (selectionLocked && !e.shiftKey) {
      selectedIds.clear();
    }

    for (let i = 0; i < pixels.length; i++) {
      const px = pixels[i][0];
      const py = pixels[i][1];
      if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
        selectedIds.add(filtered[i].id);
      }
    }

    renderProperties();
  });
}

async function bulkDeleteProperties() {
  const ids = [...selectedIds];
  if (ids.length === 0) return;
  if (!confirm(`Delete ${ids.length} properties? This cannot be undone.`)) return;

  // Optimistic local removal
  const idsSet = new Set(ids);
  data.properties = data.properties.filter(p => !idsSet.has(p.id));
  selectedIds.clear();
  renderProperties();

  try {
    const res = await fetch(`${CONFIG.apiUrl}/api/properties`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ ids, lastKnownVersion }),
    });
    if (res.ok) {
      const json = await res.json();
      lastKnownVersion = json.updatedAt || lastKnownVersion;
      if (json.notFound?.length > 0) {
        console.warn('Some properties were already deleted:', json.notFound);
      }
    } else if (res.status === 409) {
      await loadProperties();
      renderProperties();
      alert('Data was modified by another session. Properties have been refreshed.');
    } else {
      console.error('Bulk delete failed:', res.status);
      await loadProperties();
      renderProperties();
      alert('Bulk delete failed. Properties have been refreshed.');
    }
  } catch (err) {
    console.error('Bulk delete error:', err.message);
    await loadProperties();
    renderProperties();
    alert('Network error during bulk delete. Properties have been refreshed.');
  }
}

// ── Events ─────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });

  document.getElementById('login-btn').addEventListener('click', login);
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('add-btn').addEventListener('click', openAddForm);

  // Selection mode toggle button
  document.getElementById('select-mode-btn').addEventListener('click', () => {
    selectionLocked = !selectionLocked;
    if (selectionLocked) {
      enterSelectionMode();
    } else {
      exitSelectionMode();
      selectedIds.clear();
      renderProperties();
    }
  });

  // Selection bar buttons
  document.getElementById('select-all-btn').addEventListener('click', () => {
    const filtered = showStarredOnly ? data.properties.filter(p => p.starred) : data.properties;
    for (const p of filtered) selectedIds.add(p.id);
    renderProperties();
  });
  document.getElementById('select-none-btn').addEventListener('click', () => {
    selectedIds.clear();
    renderProperties();
  });
  document.getElementById('bulk-delete-btn').addEventListener('click', () => bulkDeleteProperties());

  // Shift key for temporary selection mode
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && isAdmin && !selectionLocked) {
      enterSelectionMode();
    }
    if (e.key === 'Escape') {
      selectedIds.clear();
      selectionLocked = false;
      exitSelectionMode();
      renderProperties();
    }
    if (e.key === 'Delete' && isAdmin && selectedIds.size > 0) {
      bulkDeleteProperties();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' && !selectionLocked) {
      exitSelectionMode();
    }
  });

  document.getElementById('star-filter').addEventListener('click', () => {
    showStarredOnly = !showStarredOnly;
    selectedIds.clear();
    renderProperties();
  });

  document.getElementById('rmls-btn').addEventListener('click', async () => {
    const rmlsUrl = document.getElementById('form-rmls').value.trim();
    if (!rmlsUrl) return;
    const btn = document.getElementById('rmls-btn');
    btn.textContent = '...';
    btn.disabled = true;
    try {
      const res = await fetch(`${CONFIG.apiUrl}/api/rmls-lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rmlsUrl }),
      });
      if (!res.ok) {
        alert('Could not fetch RMLS listing. Try entering the address manually.');
        return;
      }
      const info = await res.json();
      if (info.address) {
        document.getElementById('form-address').value = info.address;
        // Auto-geocode the address
        const geo = await geocodeAddress(info.address);
        if (geo) setPreviewMarker(geo.lat, geo.lng);
      }
      if (info.sourceUrl) document.getElementById('form-url').value = info.sourceUrl;
      pendingPhotoUrl = info.photoUrl || null;
      // Build notes from metadata
      const parts = [];
      if (info.price) parts.push(`$${info.price.toLocaleString()}`);
      if (info.beds) parts.push(`${info.beds} bed`);
      if (info.baths) parts.push(`${info.baths} bath`);
      if (info.sqft) parts.push(`${info.sqft.toLocaleString()} sqft`);
      if (info.yearBuilt) parts.push(`built ${info.yearBuilt}`);
      if (info.lotAcres) parts.push(`${info.lotAcres} acres`);
      else if (info.lotSqft) parts.push(`${info.lotSqft} sqft lot`);
      if (info.garage) parts.push(info.garage + ' garage');
      if (info.hoaMonthly) parts.push(`$${info.hoaMonthly}/mo HOA`);
      if (info.style) parts.push(info.style);
      else if (info.propertyType) parts.push(info.propertyType);
      if (info.mlsId) parts.push(`MLS# ${info.mlsId}`);
      if (parts.length > 0) {
        const existing = document.getElementById('form-notes').value;
        document.getElementById('form-notes').value = parts.join(' | ') + (existing ? '\n' + existing : '');
      }
    } catch (err) {
      alert('RMLS lookup failed: ' + err.message);
    } finally {
      btn.textContent = 'Lookup';
      btn.disabled = false;
    }
  });

  document.getElementById('geocode-btn').addEventListener('click', async () => {
    const addr = document.getElementById('form-address').value.trim();
    if (!addr) return;
    const btn = document.getElementById('geocode-btn');
    btn.textContent = '...';
    btn.disabled = true;
    const result = await geocodeAddress(addr);
    btn.textContent = 'Locate';
    btn.disabled = false;
    if (result) {
      setPreviewMarker(result.lat, result.lng);
    } else {
      alert('Could not find that address. Try being more specific.');
    }
  });

  document.getElementById('save-btn').addEventListener('click', async () => {
    const prop = readFormData();
    if (!prop.address) return alert('Address is required.');
    if (!prop.lat && !prop.lng) return alert('Click "Locate" to geocode the address first.');
    await saveProperty(prop);
    hideForm();
  });

  document.getElementById('cancel-btn').addEventListener('click', hideForm);

  document.getElementById('delete-btn').addEventListener('click', async () => {
    if (!editingId) return;
    if (!confirm('Delete this property?')) return;
    await deleteProperty(editingId);
    hideForm();
  });
}

// ── Helpers ─────────────────────────────────────────────────
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}
