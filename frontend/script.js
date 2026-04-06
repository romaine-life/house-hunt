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

  map.events.add('ready', () => {
    datasource = new atlas.source.DataSource();
    map.sources.add(datasource);

    // Bubble layer for colored dots
    const bubbleLayer = new atlas.layer.BubbleLayer(datasource, null, {
      radius: 10,
      strokeWidth: 2,
      strokeColor: '#11111b',
      color: ['get', 'color'],
    });

    // Symbol layer for labels (address below pin)
    const symbolLayer = new atlas.layer.SymbolLayer(datasource, null, {
      iconOptions: { image: 'none' },
      textOptions: {
        textField: ['get', 'shortAddress'],
        offset: [0, 1.2],
        size: 11,
        color: '#cdd6f4',
        haloColor: '#11111b',
        haloWidth: 1,
      },
    });

    map.layers.add([bubbleLayer, symbolLayer]);

    // Popup on click
    popup = new atlas.Popup({ closeButton: true, pixelOffset: [0, -12] });

    map.events.add('click', bubbleLayer, (e) => {
      if (e.shapes?.length > 0) {
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

    map.events.add('mousemove', bubbleLayer, () => {
      map.getCanvasContainer().style.cursor = 'pointer';
    });
    map.events.add('mouseleave', bubbleLayer, () => {
      map.getCanvasContainer().style.cursor = '';
    });
  });
}

function buildPopup(props) {
  const statusColor = STATUS_COLORS[props.status] || '#cdd6f4';
  let html = `<div style="font-family:'Segoe UI',system-ui,sans-serif;color:#cdd6f4;background:#181825;padding:10px 12px;border-radius:6px;min-width:200px;max-width:300px;">`;
  html += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:${statusColor};margin-bottom:4px;">${props.status}</div>`;
  html += `<div style="font-size:14px;font-weight:600;margin-bottom:6px;">${esc(props.address)}</div>`;

  if (props.notes) {
    html += `<div style="font-size:12px;color:#a6adc8;margin-bottom:6px;white-space:pre-wrap;">${esc(props.notes)}</div>`;
  }

  const schema = data.checklistSchema;
  if (schema.length > 0 && props.checklist) {
    html += '<ul style="list-style:none;font-size:12px;margin-bottom:6px;padding:0;">';
    for (const item of schema) {
      const val = props.checklist[item.key];
      const color = val === true ? '#a6e3a1' : val === false ? '#f38ba8' : '#6c7086';
      const icon = val === true ? '\u2713' : val === false ? '\u2717' : '\u2014';
      html += `<li style="padding:1px 0;color:${color};">${icon} ${esc(item.label)}</li>`;
    }
    html += '</ul>';
  }

  if (props.listingUrl) {
    html += `<div style="font-size:12px;"><a href="${esc(props.listingUrl)}" target="_blank" rel="noopener" style="color:#89b4fa;">View listing</a></div>`;
  }

  html += '</div>';
  return html;
}

function fitMapToData() {
  if (datasource.getShapes().length === 0) return;
  const bounds = atlas.data.BoundingBox.fromData(datasource.toJson());
  map.setCamera({ bounds, padding: 50 });
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
  // Update map datasource
  if (datasource) {
    datasource.clear();
    for (const prop of data.properties) {
      const feature = new atlas.data.Feature(
        new atlas.data.Point([prop.lng, prop.lat]),
        {
          id: prop.id,
          address: prop.address,
          shortAddress: prop.address.split(',')[0],
          notes: prop.notes,
          status: prop.status,
          checklist: prop.checklist,
          listingUrl: prop.listingUrl,
          color: STATUS_COLORS[prop.status] || STATUS_COLORS.interested,
        },
      );
      datasource.add(feature);
    }
    fitMapToData();
  }

  // Sidebar list
  const container = document.getElementById('properties');
  container.innerHTML = '';

  if (data.properties.length === 0) {
    container.innerHTML = '<p style="color:var(--subtext0);font-size:13px;">No properties yet.</p>';
    return;
  }

  for (const prop of data.properties) {
    const card = document.createElement('div');
    card.className = 'property-card';
    card.dataset.id = prop.id;
    card.innerHTML = `
      <div class="address">${esc(prop.address)}</div>
      <div class="meta">
        <span class="status-dot ${prop.status}"></span>
        <span>${prop.status}</span>
      </div>
    `;
    card.addEventListener('click', () => {
      map.setCamera({ center: [prop.lng, prop.lat], zoom: 15 });
      // Open popup
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
  document.getElementById('form-address').value = '';
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
    const checked = values[item.key] === true ? 'checked' : '';
    div.innerHTML = `
      <input type="checkbox" id="cl-${item.key}" data-key="${item.key}" ${checked} />
      <label for="cl-${item.key}">${esc(item.label)}</label>
    `;
    container.appendChild(div);
  }
}

function readFormData() {
  const checklist = {};
  document.querySelectorAll('#form-checklist input[type="checkbox"]').forEach(cb => {
    checklist[cb.dataset.key] = cb.checked;
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
    addedAt: existing?.addedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ── Geocoding (Azure Maps Search API) ──────────────────────
let previewMarkerPos = null;

async function geocodeAddress(address) {
  const url = `https://atlas.microsoft.com/search/address/json?api-version=1.0&query=${encodeURIComponent(address)}`;
  try {
    // Use the map's auth to make the request
    const tokenRes = await fetch(`${CONFIG.apiUrl}/maps/token`);
    const { token } = await tokenRes.json();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
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
      { color: STATUS_COLORS.interested, shortAddress: '', id: '__preview' },
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

// ── Events ─────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });

  document.getElementById('login-btn').addEventListener('click', login);
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('add-btn').addEventListener('click', openAddForm);

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
