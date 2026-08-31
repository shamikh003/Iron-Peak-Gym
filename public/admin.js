 /* ===================================================================
   IRONPEAK GYM: staff dashboard
   Talks to the backend API (see server.js). All protected endpoints
   require a logged-in session (httpOnly cookie set by /api/auth/login).
   =================================================================== */

const WHATSAPP_COUNTRY_CODE = '92'; // Pakistan; used when a phone starts with 0

let clientsCache = [];
let currentFilter = 'all';
let currentSearch = '';
let pendingDeleteId = null;

/* ---- API helpers ------------------------------------------------- */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthorized');
  }
  return res;
}

function formatPhoneForWhatsapp(phone) {
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);          // 0092... -> 92...
  if (digits.startsWith('0')) return WHATSAPP_COUNTRY_CODE + digits.slice(1); // 0300... -> 92300...
  if (!digits.startsWith(WHATSAPP_COUNTRY_CODE)) return WHATSAPP_COUNTRY_CODE + digits; // 300... -> 92300...
  return digits;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

/* ===================================================================
   AUTH
   =================================================================== */
function showLogin() {
  document.getElementById('loginOverlay').classList.add('visible');
  document.getElementById('appShell').classList.add('locked');
  document.getElementById('logoutBtn').hidden = true;
  const u = document.getElementById('loginUser');
  if (u) u.focus();
}
function hideLogin() {
  document.getElementById('loginOverlay').classList.remove('visible');
  document.getElementById('appShell').classList.remove('locked');
  document.getElementById('logoutBtn').hidden = false;
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.authenticated) {
      hideLogin();
      await loadAndRender();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

/* ===================================================================
   DATA + RENDER
   =================================================================== */
async function loadAndRender() {
  try {
    const res = await api('/api/clients');
    clientsCache = await res.json();
    render();
  } catch (err) {
    if (err.message !== 'unauthorized') console.error(err);
  }
}

function render() {
  const tbody = document.getElementById('clientTableBody');
  const emptyState = document.getElementById('emptyState');

  const activeClients = clientsCache.filter(c => c.approvalStatus !== 'pending');

  // Stats (from active clients only, not counting ones still pending approval)
  let paid = 0, due = 0, overdue = 0;
  activeClients.forEach(c => {
    if (c.status === 'paid') paid++;
    else if (c.status === 'due') due++;
    else overdue++;
  });
  document.getElementById('statTotal').textContent = activeClients.length;
  document.getElementById('statPaid').textContent = paid;
  document.getElementById('statDue').textContent = due;
  document.getElementById('statOverdue').textContent = overdue;

  // Filter + search
  const q = currentSearch.trim().toLowerCase();
  const filtered = activeClients.filter(c => {
    const matchesFilter = currentFilter === 'all' || c.status === currentFilter;
    const matchesSearch = q === '' || c.name.toLowerCase().includes(q) || c.phone.includes(q);
    return matchesFilter && matchesSearch;
  });

  tbody.innerHTML = '';
  emptyState.classList.toggle('visible', filtered.length === 0);
  emptyState.textContent = activeClients.length === 0
    ? 'There are no client records yet. Add a client via the Admission form or Quick Add.'
    : 'No clients match this search/filter.';

  filtered.forEach(client => {
    const label = client.status === 'paid' ? 'Paid' : client.status === 'due' ? 'Due Soon' : 'Overdue';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="client-id">${escapeHtml(client.clientId)}</td>
      <td>${escapeHtml(client.name)}</td>
      <td>${escapeHtml(client.phone)}</td>
      <td>${escapeHtml(client.plan)}</td>
      <td>${escapeHtml(client.joinDate)}</td>
      <td>${escapeHtml(client.dueDate)}</td>
      <td><span class="status-badge ${client.status}">${label}</span></td>
      <td class="row-actions">
        <button class="action-paid" data-id="${client.id}">Mark Paid</button>
        <button class="action-remind" data-id="${client.id}">Remind</button>
        <button class="action-delete" data-id="${client.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  renderPending();
}

function renderPending() {
  const pendingClients = clientsCache.filter(c => c.approvalStatus === 'pending');
  const section = document.getElementById('pendingSection');
  const list = document.getElementById('pendingList');
  const badge = document.getElementById('pendingCountBadge');

  section.hidden = pendingClients.length === 0;
  badge.textContent = pendingClients.length;
  list.innerHTML = '';

  pendingClients.forEach(client => {
    const card = document.createElement('div');
    card.className = 'pending-card';
    card.innerHTML = `
      <div class="pending-card-info">
        <div class="pending-card-name">${escapeHtml(client.name)} <span class="client-id">${escapeHtml(client.clientId)}</span></div>
        <div class="pending-card-meta">
          <span>${escapeHtml(client.phone)}</span>
          <span>${escapeHtml(client.plan)} — Rs. ${escapeHtml(String(client.planPrice))}</span>
          <span>Submitted ${escapeHtml(client.joinDate)}</span>
        </div>
      </div>
      <div class="pending-card-actions">
        <button class="action-approve" data-id="${client.id}">Approve</button>
        <button class="action-reject" data-id="${client.id}">Reject</button>
      </div>
    `;
    list.appendChild(card);
  });
}

/* ===================================================================
   ROW ACTIONS (event delegation, set up once)
   =================================================================== */
function findClient(id) {
  return clientsCache.find(c => String(c.id) === String(id));
}

function setupTableActions() {
  const tbody = document.getElementById('clientTableBody');
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;

    if (btn.classList.contains('action-paid')) {
      btn.disabled = true;
      try {
        await api(`/api/clients/${id}/pay`, { method: 'POST' });
        await loadAndRender();
      } catch (err) { if (err.message !== 'unauthorized') alert('Could not mark as paid.'); btn.disabled = false; }
    }

    else if (btn.classList.contains('action-remind')) {
      const client = findClient(id);
      if (!client) return;
      const message = `Hello ${client.name}, this is a reminder from IronPeak Gym. Your fee is due on ${client.dueDate} (${client.plan} plan). Kindly pay on time. Thank you!`;
      const phone = formatPhoneForWhatsapp(client.phone);
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
    }

    else if (btn.classList.contains('action-delete')) {
      pendingDeleteId = id;
      document.getElementById('deleteOverlay').classList.add('visible');
    }
  });
}

function setupPendingActions() {
  const list = document.getElementById('pendingList');
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;

    if (btn.classList.contains('action-approve')) {
      btn.disabled = true;
      try {
        await api(`/api/clients/${id}/approve`, { method: 'POST' });
        await loadAndRender();
      } catch (err) {
        if (err.message !== 'unauthorized') alert('Could not approve this admission.');
        btn.disabled = false;
      }
    }

    else if (btn.classList.contains('action-reject')) {
      if (!confirm('Reject and remove this admission request?')) return;
      btn.disabled = true;
      try {
        await api(`/api/clients/${id}/reject`, { method: 'POST' });
        await loadAndRender();
      } catch (err) {
        if (err.message !== 'unauthorized') alert('Could not reject this admission.');
        btn.disabled = false;
      }
    }
  });
}

/* ===================================================================
   INIT
   =================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  setupTableActions();
  setupPendingActions();
  checkAuth();

  /* ---- Login ---- */
  const loginForm = document.getElementById('loginForm');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('loginError');
    const btn = loginForm.querySelector('button[type="submit"]');
    errorEl.textContent = '';
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('loginUser').value,
          password: document.getElementById('loginPass').value,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errorEl.textContent = data.error || 'Login failed.';
        return;
      }
      loginForm.reset();
      hideLogin();
      await loadAndRender();
    } catch {
      errorEl.textContent = 'Could not connect to the server.';
    } finally {
      btn.disabled = false;
    }
  });

  /* ---- Logout ---- */
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    clientsCache = [];
    render();
    showLogin();
  });

  /* ---- Search ---- */
  document.getElementById('searchInput').addEventListener('input', (e) => {
    currentSearch = e.target.value;
    render();
  });

  /* ---- Status filter chips ---- */
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.status;
      render();
    });
  });

  /* ---- Quick Add modal ---- */
  const modalOverlay = document.getElementById('modalOverlay');
  document.getElementById('addClientBtn').addEventListener('click', () => modalOverlay.classList.add('visible'));
  document.getElementById('modalClose').addEventListener('click', () => modalOverlay.classList.remove('visible'));
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.classList.remove('visible'); });

  document.getElementById('quickAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('qaName').value.trim();
    const phone = document.getElementById('qaPhone').value.trim();
    const planValue = document.getElementById('qaPlan').value;
    if (!name || !phone || !planValue) return;
    const [plan] = planValue.split('|');
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await api('/api/clients/quick', {
        method: 'POST',
        body: JSON.stringify({ name, phone, plan }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.errors ? Object.values(data.errors).join('\n') : 'Could not add client.');
        return;
      }
      e.target.reset();
      modalOverlay.classList.remove('visible');
      await loadAndRender();
    } catch (err) {
      if (err.message !== 'unauthorized') alert('Could not add client.');
    } finally {
      btn.disabled = false;
    }
  });

  /* ---- Delete confirm modal ---- */
  const deleteOverlay = document.getElementById('deleteOverlay');
  document.getElementById('deleteConfirm').addEventListener('click', async () => {
    if (pendingDeleteId != null) {
      try {
        await api(`/api/clients/${pendingDeleteId}`, { method: 'DELETE' });
        await loadAndRender();
      } catch (err) { if (err.message !== 'unauthorized') alert('Could not delete.'); }
    }
    pendingDeleteId = null;
    deleteOverlay.classList.remove('visible');
  });
  document.getElementById('deleteModalClose').addEventListener('click', () => { pendingDeleteId = null; deleteOverlay.classList.remove('visible'); });
  document.getElementById('deleteCancel').addEventListener('click', () => { pendingDeleteId = null; deleteOverlay.classList.remove('visible'); });
  deleteOverlay.addEventListener('click', (e) => { if (e.target === deleteOverlay) { pendingDeleteId = null; deleteOverlay.classList.remove('visible'); } });

  /* ---- ESC closes any open modal ---- */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    [modalOverlay, deleteOverlay].forEach(m => m.classList.remove('visible'));
  });
});
