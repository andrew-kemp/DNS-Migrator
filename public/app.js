// ── State ────────────────────────────────────────────────────────────────────

let state = {
  currentStep: 1,
  maxStep: 1,
  cf: { token: null, accountId: null, accountName: null },
  source: null, // 'scan' | 'azure' | 'manual'
  azure: { token: null, authMethod: 'bearerToken', subscriptionId: null },
  zones: [], // { name, source, records?, resourceGroup? }
};

// ── Step navigation ─────────────────────────────────────────────────────────

function goToStep(step) {
  if (step > state.maxStep) return;
  state.currentStep = step;
  document.querySelectorAll('.step').forEach((el) => el.classList.remove('active'));
  document.getElementById(`step-${step}`).classList.add('active');
  updateStepIndicators();
}

function advanceToStep(step) {
  state.maxStep = Math.max(state.maxStep, step);
  goToStep(step);
}

function updateStepIndicators() {
  document.querySelectorAll('.step-ind').forEach((btn) => {
    const s = parseInt(btn.dataset.step);
    btn.disabled = s > state.maxStep;
    if (s === state.currentStep) {
      btn.className = btn.className.replace(/bg-gray-800 text-gray-400|bg-green-800 text-green-300/g, 'bg-orange-600 text-white');
      btn.querySelector('span').className = btn.querySelector('span').className.replace(/bg-gray-700|bg-green-700/g, 'bg-white/20');
    } else if (s < state.maxStep) {
      btn.className = btn.className.replace(/bg-orange-600 text-white|bg-gray-800 text-gray-400/g, 'bg-green-800 text-green-300');
      btn.querySelector('span').className = btn.querySelector('span').className.replace(/bg-white\/20|bg-gray-700/g, 'bg-green-700');
    } else {
      btn.className = btn.className.replace(/bg-orange-600 text-white|bg-green-800 text-green-300/g, 'bg-gray-800 text-gray-400');
      btn.querySelector('span').className = btn.querySelector('span').className.replace(/bg-white\/20|bg-green-700/g, 'bg-gray-700');
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function api(endpoint, body) {
  return fetch(`/api${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (loading) {
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    btn.innerHTML = '<svg class="w-4 h-4 inline spinner mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>Working...';
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.originalText || 'Submit';
  }
}

function setStatus(id, message, type) {
  const el = document.getElementById(id);
  const colors = { success: 'text-green-400', error: 'text-red-400', info: 'text-blue-400' };
  el.className = `text-sm ${colors[type] || 'text-gray-400'}`;
  el.textContent = message;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Step 1: Cloudflare ──────────────────────────────────────────────────────

async function validateCloudflare() {
  const token = document.getElementById('cf-token').value.trim();
  if (!token) return setStatus('cf-status', 'Please enter an API token', 'error');

  setLoading('cf-validate-btn', true);
  setStatus('cf-status', '', 'info');

  try {
    const res = await api('/cloudflare/validate', { apiToken: token });
    const data = await res.json();

    if (!res.ok || !data.success) throw new Error(data.error || 'Validation failed');

    state.cf.token = token;

    const select = document.getElementById('cf-account');
    select.innerHTML = '';
    for (const acc of data.accounts) {
      const opt = document.createElement('option');
      opt.value = acc.id;
      opt.textContent = `${acc.name} (${acc.id.slice(0, 8)}...)`;
      select.appendChild(opt);
    }

    if (data.accounts.length === 1) {
      state.cf.accountId = data.accounts[0].id;
      state.cf.accountName = data.accounts[0].name;
      setStatus('cf-status', `Connected to ${data.accounts[0].name}`, 'success');
      advanceToStep(2);
    } else {
      document.getElementById('cf-account-select').classList.remove('hidden');
      state.cf.accountId = data.accounts[0].id;
      state.cf.accountName = data.accounts[0].name;
      select.onchange = () => {
        const selected = data.accounts.find((a) => a.id === select.value);
        state.cf.accountId = selected.id;
        state.cf.accountName = selected.name;
      };
      setStatus('cf-status', 'Select your account and proceed', 'success');
      advanceToStep(2);
    }
  } catch (err) {
    setStatus('cf-status', err.message, 'error');
  } finally {
    setLoading('cf-validate-btn', false);
  }
}

// ── Step 2: Source selection ─────────────────────────────────────────────────

function selectSource(source) {
  state.source = source;
  document.querySelectorAll('.source-card').forEach((el) => {
    el.classList.toggle('selected', el.dataset.source === source);
  });

  const setup = document.getElementById('source-setup');

  if (source === 'scan') {
    setup.innerHTML = `
      <div class="mt-6 space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1">Domain Names</label>
          <textarea id="scan-domains" rows="4" placeholder="Enter domain names, one per line&#10;example.com&#10;mysite.co.uk"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 font-mono text-sm"></textarea>
          <p class="text-xs text-gray-500 mt-1">DNS records will be discovered by scanning live DNS — works with any provider (GoDaddy, Route53, Azure, etc.).</p>
        </div>
        <div class="flex items-center gap-3">
          <button onclick="startDnsScan()" id="scan-btn"
            class="px-5 py-2.5 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium transition-colors">
            Scan & Continue
          </button>
          <span id="scan-status" class="text-sm"></span>
        </div>
      </div>`;
  } else if (source === 'azure') {
    setup.innerHTML = `
      <div class="mt-6 space-y-4">
        <div class="flex gap-2 mb-2">
          <button onclick="setAzureAuth('bearerToken')" id="az-tab-bearer"
            class="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white transition-colors">
            Bearer Token (quick)
          </button>
          <button onclick="setAzureAuth('servicePrincipal')" id="az-tab-sp"
            class="px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 text-gray-400 hover:bg-gray-700 transition-colors">
            Service Principal
          </button>
        </div>
        <div id="az-bearer-form" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-300 mb-1">Bearer Token</label>
            <textarea id="az-bearer" rows="3" placeholder="Paste your Azure bearer token"
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-xs"></textarea>
            <p class="text-xs text-gray-500 mt-1">
              Get it by running: <code class="bg-gray-800 px-1.5 py-0.5 rounded text-orange-400">az account get-access-token --resource https://management.azure.com --query accessToken -o tsv</code>
            </p>
          </div>
        </div>
        <div id="az-sp-form" class="space-y-4 hidden">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-300 mb-1">Tenant ID</label>
              <input type="text" id="az-tenant" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500">
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-300 mb-1">Client ID</label>
              <input type="text" id="az-client-id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500">
            </div>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-300 mb-1">Client Secret</label>
            <input type="password" id="az-client-secret" placeholder="Enter client secret"
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500">
          </div>
        </div>
        <div id="az-sub-select" class="hidden">
          <label class="block text-sm font-medium text-gray-300 mb-1">Subscription</label>
          <select id="az-subscription"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-blue-500">
          </select>
        </div>
        <div class="flex items-center gap-3">
          <button onclick="validateAzure()" id="az-validate-btn"
            class="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors">
            Validate & Connect
          </button>
          <span id="az-status" class="text-sm"></span>
        </div>
      </div>`;
  } else if (source === 'manual') {
    setup.innerHTML = `
      <div class="mt-6 space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1">Domain Names</label>
          <textarea id="manual-domains" rows="4" placeholder="Enter domain names, one per line&#10;example.com&#10;mysite.co.uk"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 font-mono text-sm"></textarea>
          <p class="text-xs text-gray-500 mt-1">Zones will be created in Cloudflare without importing records. You can add records later in the CF dashboard.</p>
        </div>
        <div class="flex items-center gap-3">
          <button onclick="submitManualDomains()" id="manual-btn"
            class="px-5 py-2.5 bg-green-600 hover:bg-green-500 rounded-lg font-medium transition-colors">
            Continue
          </button>
        </div>
      </div>`;
  }
}

// ── DNS Scan source ─────────────────────────────────────────────────────────

async function startDnsScan() {
  const raw = document.getElementById('scan-domains').value.trim();
  if (!raw) return setStatus('scan-status', 'Enter at least one domain', 'error');

  const domains = raw.split(/[\n,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (domains.length === 0) return setStatus('scan-status', 'Enter at least one domain', 'error');

  setLoading('scan-btn', true);
  state.zones = [];

  // Show step 3 with scan progress
  document.getElementById('step3-title').textContent = 'Scanning DNS Records';
  document.getElementById('step3-desc').textContent = `Scanning ${domains.length} domain(s) via DNS lookup...`;
  document.getElementById('scan-progress').classList.remove('hidden');
  document.getElementById('scan-log').innerHTML = '';
  document.getElementById('zone-list').innerHTML = '';
  advanceToStep(3);

  for (const domain of domains) {
    addScanLog(`Starting scan for ${domain}...`, 'status');

    try {
      const res = await fetch('/api/dns/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let zoneRecords = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'done') {
              zoneRecords = event.records || [];
              addScanLog(`${domain}: found ${event.total} records (${event.subdomainsFound?.length || 0} subdomains discovered)`, 'info');
            } else if (event.type === 'error') {
              addScanLog(`${domain}: ${event.message}`, 'error');
            } else if (event.type === 'progress' || event.type === 'status' || event.type === 'info') {
              addScanLog(`${domain}: ${event.message}`, event.type);
            }
          } catch { /* ignore non-JSON */ }
        }
      }

      state.zones.push({ name: domain, source: 'scan', records: zoneRecords, recordCount: zoneRecords.length });
    } catch (err) {
      addScanLog(`${domain}: scan failed — ${err.message}`, 'error');
      state.zones.push({ name: domain, source: 'scan', records: [], recordCount: 0 });
    }
  }

  setLoading('scan-btn', false);
  document.getElementById('step3-title').textContent = 'Select Domains to Migrate';
  document.getElementById('step3-desc').textContent = 'Review scanned domains and select which to migrate.';
  renderZoneList();
}

function addScanLog(message, type) {
  const log = document.getElementById('scan-log');
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type || 'info'}`;
  entry.textContent = message;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

// ── Azure source ────────────────────────────────────────────────────────────

function setAzureAuth(method) {
  state.azure.authMethod = method;
  const bearerForm = document.getElementById('az-bearer-form');
  const spForm = document.getElementById('az-sp-form');
  const tabBearer = document.getElementById('az-tab-bearer');
  const tabSp = document.getElementById('az-tab-sp');

  if (method === 'bearerToken') {
    bearerForm.classList.remove('hidden');
    spForm.classList.add('hidden');
    tabBearer.className = tabBearer.className.replace('bg-gray-800 text-gray-400 hover:bg-gray-700', 'bg-blue-600 text-white');
    tabSp.className = tabSp.className.replace('bg-blue-600 text-white', 'bg-gray-800 text-gray-400 hover:bg-gray-700');
  } else {
    bearerForm.classList.add('hidden');
    spForm.classList.remove('hidden');
    tabSp.className = tabSp.className.replace('bg-gray-800 text-gray-400 hover:bg-gray-700', 'bg-blue-600 text-white');
    tabBearer.className = tabBearer.className.replace('bg-blue-600 text-white', 'bg-gray-800 text-gray-400 hover:bg-gray-700');
  }
}

async function validateAzure() {
  setLoading('az-validate-btn', true);
  setStatus('az-status', '', 'info');

  const body = { authMethod: state.azure.authMethod };

  if (state.azure.authMethod === 'bearerToken') {
    body.bearerToken = document.getElementById('az-bearer').value.trim();
    if (!body.bearerToken) {
      setLoading('az-validate-btn', false);
      return setStatus('az-status', 'Please enter a bearer token', 'error');
    }
  } else {
    body.tenantId = document.getElementById('az-tenant').value.trim();
    body.clientId = document.getElementById('az-client-id').value.trim();
    body.clientSecret = document.getElementById('az-client-secret').value.trim();
    if (!body.tenantId || !body.clientId || !body.clientSecret) {
      setLoading('az-validate-btn', false);
      return setStatus('az-status', 'All fields are required', 'error');
    }
  }

  try {
    const res = await api('/azure/validate', body);
    const data = await res.json();

    if (!res.ok || !data.success) throw new Error(data.error || 'Validation failed');

    state.azure.token = data.token;

    const select = document.getElementById('az-subscription');
    select.innerHTML = '';
    const enabledSubs = data.subscriptions.filter((s) => s.state === 'Enabled');

    for (const sub of enabledSubs) {
      const opt = document.createElement('option');
      opt.value = sub.id;
      opt.textContent = `${sub.name} (${sub.id.slice(0, 8)}...)`;
      select.appendChild(opt);
    }

    document.getElementById('az-sub-select').classList.remove('hidden');
    state.azure.subscriptionId = enabledSubs[0]?.id;

    select.onchange = () => {
      state.azure.subscriptionId = select.value;
      loadAzureZones();
    };

    setStatus('az-status', `Found ${enabledSubs.length} subscription(s)`, 'success');
    await loadAzureZones();
  } catch (err) {
    setStatus('az-status', err.message, 'error');
  } finally {
    setLoading('az-validate-btn', false);
  }
}

async function loadAzureZones() {
  setStatus('az-status', 'Loading DNS zones...', 'info');

  try {
    const res = await api('/azure/zones', {
      token: state.azure.token,
      subscriptionId: state.azure.subscriptionId,
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      setStatus('az-status', data.error || `Failed to load zones (HTTP ${res.status})`, 'error');
      return;
    }

    if (!data.zones || data.zones.length === 0) {
      setStatus('az-status', 'No DNS zones found in this subscription. Try selecting a different subscription if you have multiple.', 'error');
      return;
    }

    state.zones = data.zones.map((z) => ({
      name: z.name,
      source: 'azure',
      resourceGroup: z.resourceGroup,
      recordCount: z.numberOfRecordSets,
    }));

    setStatus('az-status', `Found ${state.zones.length} DNS zone(s)`, 'success');
    document.getElementById('step3-title').textContent = 'Select Azure DNS Zones';
    document.getElementById('step3-desc').textContent = 'Choose which zones to migrate to Cloudflare.';
    document.getElementById('scan-progress').classList.add('hidden');
    renderZoneList();
    advanceToStep(3);
  } catch (err) {
    setStatus('az-status', `Failed to load zones: ${err.message}`, 'error');
  }
}

// ── Manual source ───────────────────────────────────────────────────────────

function submitManualDomains() {
  const raw = document.getElementById('manual-domains').value.trim();
  if (!raw) return;

  const domains = raw.split(/[\n,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (domains.length === 0) return;

  state.zones = domains.map((d) => ({ name: d, source: 'manual', records: [], recordCount: 0 }));

  document.getElementById('step3-title').textContent = 'Select Domains';
  document.getElementById('step3-desc').textContent = 'Zones will be created in Cloudflare without importing records.';
  document.getElementById('scan-progress').classList.add('hidden');
  renderZoneList();
  advanceToStep(3);
}

// ── Step 3: Zone selection ──────────────────────────────────────────────────

function renderZoneList() {
  const container = document.getElementById('zone-list');
  container.innerHTML = '';
  document.getElementById('zone-count').textContent = `${state.zones.length} domain(s) found`;

  for (const zone of state.zones) {
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between bg-gray-800 rounded-lg px-4 py-3 hover:bg-gray-750 transition-colors';

    let meta = '';
    if (zone.source === 'azure') meta = `<span class="text-xs text-gray-500 ml-2">RG: ${escapeHtml(zone.resourceGroup)}</span>`;
    if (zone.source === 'scan') meta = `<span class="text-xs text-gray-500 ml-2">scanned</span>`;
    if (zone.source === 'manual') meta = `<span class="text-xs text-gray-500 ml-2">manual</span>`;

    div.innerHTML = `
      <label class="flex items-center gap-3 cursor-pointer flex-1">
        <input type="checkbox" class="zone-checkbox w-4 h-4 rounded bg-gray-700 border-gray-600 text-orange-500 focus:ring-orange-500"
          data-zone="${escapeHtml(zone.name)}" data-idx="${state.zones.indexOf(zone)}" checked onchange="updateSelectedCount()">
        <div>
          <span class="font-medium">${escapeHtml(zone.name)}</span>
          ${meta}
        </div>
      </label>
      <span class="text-xs text-gray-500">${zone.recordCount} records</span>
    `;
    container.appendChild(div);
  }

  document.getElementById('select-all').checked = true;
  updateSelectedCount();
}

function toggleSelectAll() {
  const checked = document.getElementById('select-all').checked;
  document.querySelectorAll('.zone-checkbox').forEach((cb) => (cb.checked = checked));
  updateSelectedCount();
}

function updateSelectedCount() {
  const count = document.querySelectorAll('.zone-checkbox:checked').length;
  document.getElementById('zone-selected-count').textContent = count > 0 ? `${count} domain(s) selected` : '';
  document.getElementById('migrate-btn').disabled = count === 0;
}

// ── Step 4: Migration ───────────────────────────────────────────────────────

function addLogEntry(message, type) {
  const log = document.getElementById('migration-log');
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type || 'info'}`;
  entry.textContent = message;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

async function startMigration() {
  const selectedZones = [];
  document.querySelectorAll('.zone-checkbox:checked').forEach((cb) => {
    const idx = parseInt(cb.dataset.idx);
    selectedZones.push(state.zones[idx]);
  });

  if (selectedZones.length === 0) return;

  advanceToStep(4);

  // Reset migration log
  document.getElementById('migration-log').innerHTML = '';
  document.getElementById('migration-results').classList.add('hidden');
  document.getElementById('migration-status').innerHTML =
    '<svg class="w-4 h-4 inline spinner" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Running...';

  addLogEntry(`Starting migration of ${selectedZones.length} domain(s)...`, 'info');
  addLogEntry(`Cloudflare account: ${state.cf.accountName}`, 'info');
  addLogEntry(`Source: ${state.source}`, 'info');
  addLogEntry('', 'info');

  const allResults = [];

  // Process domains in parallel batches of 3
  const DOMAIN_CONCURRENCY = 3;

  async function migrateSingleZone(zone) {
    const payload = {
      cfToken: state.cf.token,
      cfAccountId: state.cf.accountId,
      zone,
    };

    if (state.source === 'azure') {
      payload.azureToken = state.azure.token;
      payload.subscriptionId = state.azure.subscriptionId;
    }

    try {
      const res = await fetch('/api/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            handleMigrationEvent(event);
            if (event.type === 'done' && event.results) {
              result = event.results;
            }
          } catch { /* non-JSON line */ }
        }
      }

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          handleMigrationEvent(event);
          if (event.type === 'done' && event.results) {
            result = event.results;
          }
        } catch { /* ignore */ }
      }

      return result || [];
    } catch (err) {
      addLogEntry(`[${zone.name}] Fatal error: ${err.message}`, 'error');
      return [{ name: zone.name, status: 'failed', created: 0, skipped: 0, failed: 0, nameServers: [], errors: [err.message] }];
    }
  }

  for (let i = 0; i < selectedZones.length; i += DOMAIN_CONCURRENCY) {
    const batch = selectedZones.slice(i, i + DOMAIN_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(migrateSingleZone));
    for (const r of batchResults) allResults.push(...r);
  }

  addLogEntry('--- Migration complete ---', 'info');
  document.getElementById('migration-status').innerHTML = '<span class="text-green-400">Complete</span>';
  if (allResults.length > 0) showResults(allResults);
}

function handleMigrationEvent(event) {
  const prefix = event.zone ? `[${event.zone}] ` : '';
  switch (event.type) {
    case 'status':
      addLogEntry(`${prefix}${event.message}`, 'status');
      break;
    case 'info':
      addLogEntry(`${prefix}${event.message}`, 'info');
      break;
    case 'record':
      addLogEntry(`${prefix}+ ${event.message}`, 'record');
      break;
    case 'skip':
      addLogEntry(`${prefix}~ ${event.message}`, 'skip');
      break;
    case 'error':
      addLogEntry(`${prefix}x ${event.message}`, 'error');
      break;
    case 'success':
      addLogEntry(`${prefix}+ ${event.message}`, 'record');
      break;
    case 'zone-complete':
      addLogEntry(`${prefix}Zone migration finished (${event.result.created} created, ${event.result.skipped} skipped, ${event.result.failed} failed)`, 'info');
      addLogEntry('', 'info');
      break;
    case 'done':
      // handled by startMigration loop
      break;
  }
}

function buildRecordDetails(r) {
  let html = '';
  if (r.skippedRecords && r.skippedRecords.length > 0) {
    const rows = r.skippedRecords.map(s => `
      <tr class="border-t border-gray-700">
        <td class="py-1 pr-2 text-yellow-400 text-xs font-mono">${escapeHtml(s.type)}</td>
        <td class="py-1 pr-2 text-xs text-gray-300 font-mono truncate max-w-[180px]" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</td>
        <td class="py-1 pr-2 text-xs text-gray-400 font-mono truncate max-w-[200px]" title="${escapeHtml(s.content || '')}">${escapeHtml(s.content || '-')}</td>
        <td class="py-1 text-xs text-gray-500">${escapeHtml(s.reason)}</td>
      </tr>
    `).join('');
    html += `
      <details class="mb-3">
        <summary class="cursor-pointer text-sm text-yellow-400 hover:text-yellow-300 mb-1">Skipped records (${r.skippedRecords.length})</summary>
        <div class="overflow-x-auto">
          <table class="w-full text-left mt-1">
            <thead><tr class="text-xs text-gray-500">
              <th class="pb-1 pr-2">Type</th><th class="pb-1 pr-2">Name</th><th class="pb-1 pr-2">Value</th><th class="pb-1">Reason</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </details>`;
  }
  if (r.failedRecords && r.failedRecords.length > 0) {
    const rows = r.failedRecords.map(f => `
      <tr class="border-t border-gray-700">
        <td class="py-1 pr-2 text-red-400 text-xs font-mono">${escapeHtml(f.type)}</td>
        <td class="py-1 pr-2 text-xs text-gray-300 font-mono truncate max-w-[180px]" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</td>
        <td class="py-1 pr-2 text-xs text-gray-400 font-mono truncate max-w-[200px]" title="${escapeHtml(f.content || '')}">${escapeHtml(f.content || '-')}</td>
        <td class="py-1 text-xs text-red-300">${escapeHtml(f.error)}</td>
      </tr>
    `).join('');
    html += `
      <details class="mb-3" open>
        <summary class="cursor-pointer text-sm text-red-400 hover:text-red-300 mb-1">Failed records (${r.failedRecords.length})</summary>
        <div class="overflow-x-auto">
          <table class="w-full text-left mt-1">
            <thead><tr class="text-xs text-gray-500">
              <th class="pb-1 pr-2">Type</th><th class="pb-1 pr-2">Name</th><th class="pb-1 pr-2">Value</th><th class="pb-1">Error</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </details>`;
  }
  return html;
}

function showResults(results) {
  const container = document.getElementById('results-cards');
  container.innerHTML = '';

  for (const r of results) {
    const statusColor = r.status === 'complete' ? 'green' : r.status === 'partial' ? 'yellow' : 'red';
    const statusIcon = r.status === 'complete' ? '+' : r.status === 'partial' ? '!' : 'x';
    const nsHtml = r.nameServers.length > 0
      ? r.nameServers.map((ns) => `
          <div class="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
            <code class="text-sm text-orange-300">${escapeHtml(ns)}</code>
            <button onclick="copyToClipboard('${escapeHtml(ns)}', this)" class="text-xs text-gray-500 hover:text-white transition-colors px-2 py-1">Copy</button>
          </div>
        `).join('')
      : '<span class="text-gray-500 text-sm">No nameservers returned</span>';

    const card = document.createElement('div');
    card.className = 'bg-gray-800 rounded-lg p-5 fade-in';
    card.innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold text-lg">${escapeHtml(r.name)}</h3>
        <span class="text-${statusColor}-400 text-sm font-medium">${statusIcon} ${r.status}</span>
      </div>
      <div class="grid grid-cols-3 gap-4 mb-4 text-center">
        <div class="bg-gray-900 rounded-lg p-3">
          <div class="text-2xl font-bold text-green-400">${r.created}</div>
          <div class="text-xs text-gray-500">Created</div>
        </div>
        <div class="bg-gray-900 rounded-lg p-3">
          <div class="text-2xl font-bold text-yellow-400">${r.skipped}</div>
          <div class="text-xs text-gray-500">Skipped</div>
        </div>
        <div class="bg-gray-900 rounded-lg p-3">
          <div class="text-2xl font-bold text-${r.failed > 0 ? 'red' : 'gray'}-400">${r.failed}</div>
          <div class="text-xs text-gray-500">Failed</div>
        </div>
      </div>
      ${buildRecordDetails(r)}
      <div>
        <div class="flex items-center justify-between mb-2">
          <h4 class="text-sm font-medium text-gray-300">Nameservers</h4>
          ${r.nameServers.length > 1 ? `<button onclick="copyAllNs(this, '${r.nameServers.join(',')}')" class="text-xs text-orange-400 hover:text-orange-300">Copy All</button>` : ''}
        </div>
        <div class="space-y-1">${nsHtml}</div>
        <p class="text-xs text-gray-500 mt-2">Update these at your domain registrar to complete the migration.</p>
      </div>
    `;
    container.appendChild(card);
  }

  // Populate the dynamic next-steps section with source-aware guidance
  const nextStepsEl = document.getElementById('next-steps');
  let sourceInfo = '';
  if (state.source === 'azure') {
    sourceInfo = `
      <div class="flex items-start gap-2 bg-blue-900/30 border border-blue-800 rounded-lg p-3 mb-3">
        <svg class="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        <div class="text-sm text-blue-200">
          <strong>Your DNS was hosted on Azure DNS.</strong> After updating nameservers below, you can remove the DNS zones from the
          <a href="https://portal.azure.com/#browse/Microsoft.Network%2FdnsZones" target="_blank" rel="noopener" class="text-blue-300 hover:underline">Azure Portal → DNS zones</a>.
        </div>
      </div>`;
  } else if (state.source === 'scan') {
    sourceInfo = `
      <div class="flex items-start gap-2 bg-purple-900/30 border border-purple-800 rounded-lg p-3 mb-3">
        <svg class="w-5 h-5 text-purple-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        <div class="text-sm text-purple-200">
          <strong>Your records were scanned from live DNS.</strong> To find your current DNS provider, check the nameservers currently assigned to your domain
          (shown in your domain registrar's dashboard). That's where the old DNS records live and can be cleaned up after migration.
        </div>
      </div>`;
  }

  nextStepsEl.innerHTML = `
    <h3 class="text-sm font-semibold text-orange-400 mb-2">Next Steps</h3>
    ${sourceInfo}
    <ol class="text-sm text-gray-300 space-y-1.5 list-decimal list-inside">
      <li>Log in to your <strong>domain registrar</strong> (where you purchased the domain — e.g. GoDaddy, Namecheap, Google Domains, etc.)</li>
      <li>Update the <strong>nameservers</strong> to the Cloudflare nameservers shown above for each domain</li>
      <li>Wait for DNS propagation (can take up to 48 hours, usually much faster)</li>
      <li>Verify your domains are active in the <a href="https://dash.cloudflare.com" target="_blank" rel="noopener" class="text-orange-400 hover:underline">Cloudflare dashboard</a></li>
      <li>Once confirmed, remove the old DNS zones from your previous provider</li>
    </ol>
    <p class="text-xs text-gray-500 mt-3"><strong>Note:</strong> The registrar (where you bought the domain) and the DNS provider (where records are hosted) can be different services. Nameservers are always changed at the registrar.</p>
  `;

  document.getElementById('migration-results').classList.remove('hidden');
}

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('text-green-400');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('text-green-400');
    }, 1500);
  });
}

function copyAllNs(btn, nsString) {
  const text = nsString.split(',').join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
}
