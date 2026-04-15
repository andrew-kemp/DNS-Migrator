import { jsonError, parseBody } from './_helpers.js';

const CF_BASE = 'https://api.cloudflare.com/client/v4';
const AZURE_MGMT_URL = 'https://management.azure.com';
const DNS_API_VERSION = '2018-05-01';

async function cfFetch(token, method, endpoint, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return (await fetch(`${CF_BASE}${endpoint}`, opts)).json();
}

async function azureFetch(token, url) {
  const fullUrl = url.startsWith('http') ? url : `${AZURE_MGMT_URL}${url}`;
  const res = await fetch(fullUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Azure API error (${res.status})`);
  }
  return res.json();
}

// ── Azure record transformer ────────────────────────────────────────────────

function stripDot(s) { return s ? s.replace(/\.$/, '') : s; }

function transformAzureRecords(recordSets, zoneName) {
  const records = [];
  const skipped = [];

  for (const rs of recordSets) {
    const type = rs.type.split('/').pop().toUpperCase();
    const name = rs.name || '';
    const props = rs.properties || rs;
    const ttl = props.TTL || props.ttl || 1;

    if (type === 'SOA') { skipped.push({ type, name, reason: 'Cloudflare manages SOA' }); continue; }
    if (type === 'NS' && (name === '@' || name === zoneName)) { skipped.push({ type, name: '@', reason: 'Cloudflare manages apex NS' }); continue; }

    const push = (r) => records.push(r);
    const aRecs = props.ARecords || props.aRecords || [];
    const aaaaRecs = props.AAAARecords || props.aaaaRecords || [];
    const mxRecs = props.MXRecords || props.mxRecords || [];
    const txtRecs = props.TXTRecords || props.txtRecords || [];
    const srvRecs = props.SRVRecords || props.srvRecords || [];
    const caaRecs = props.CAARecords || props.caaRecords || [];
    const nsRecs = props.NSRecords || props.nsRecords || [];
    const ptrRecs = props.PTRRecords || props.ptrRecords || [];

    if (type === 'A') aRecs.forEach((r) => push({ type: 'A', name, content: r.ipv4Address, ttl, proxied: false }));
    if (type === 'AAAA') aaaaRecs.forEach((r) => push({ type: 'AAAA', name, content: r.ipv6Address, ttl, proxied: false }));
    if (type === 'CNAME') {
      const c = props.CNAMERecord || props.cnameRecord || props.CnameRecord;
      if (c?.cname) push({ type: 'CNAME', name, content: stripDot(c.cname), ttl, proxied: false });
    }
    if (type === 'MX') mxRecs.forEach((r) => push({ type: 'MX', name, content: stripDot(r.exchange), priority: r.preference, ttl }));
    if (type === 'TXT') txtRecs.forEach((r) => push({ type: 'TXT', name, content: Array.isArray(r.value) ? r.value.join('') : r.value, ttl }));
    if (type === 'SRV') srvRecs.forEach((r) => push({ type: 'SRV', name, ttl, data: { priority: r.priority, weight: r.weight, port: r.port, target: stripDot(r.target) } }));
    if (type === 'CAA') caaRecs.forEach((r) => push({ type: 'CAA', name, ttl, data: { flags: r.flags, tag: r.tag, value: r.value } }));
    if (type === 'NS') nsRecs.forEach((r) => push({ type: 'NS', name, content: stripDot(r.nsdname), ttl }));
    if (type === 'PTR') ptrRecs.forEach((r) => push({ type: 'PTR', name, content: stripDot(r.ptrdname), ttl }));
  }

  return { records, skipped };
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function onRequestPost({ request }) {
  const body = await parseBody(request);
  if (!body?.cfToken || !body?.cfAccountId || !body?.zone) {
    return jsonError('Missing required parameters (cfToken, cfAccountId, zone)');
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = async (event) => {
    await writer.write(encoder.encode(JSON.stringify(event) + '\n'));
  };

  (async () => {
    const zone = body.zone;

    const zoneResult = {
        name: zone.name,
        nameServers: [],
        created: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        skippedRecords: [],
        failedRecords: [],
        status: 'pending',
      };

      try {
        // Step 1: Create zone in Cloudflare
        await send({ type: 'status', zone: zone.name, message: 'Creating zone in Cloudflare...' });

        let existingZone = await cfFetch(body.cfToken, 'GET', `/zones?name=${encodeURIComponent(zone.name)}`);
        let cfZone;
        let alreadyExisted = false;

        if (existingZone.success && existingZone.result?.length > 0) {
          cfZone = existingZone.result[0];
          alreadyExisted = true;
          await send({ type: 'info', zone: zone.name, message: 'Zone already exists in Cloudflare — adding records to it' });
        } else {
          const createRes = await cfFetch(body.cfToken, 'POST', '/zones', {
            name: zone.name,
            account: { id: body.cfAccountId },
            type: 'full',
          });
          if (!createRes.success) {
            throw new Error(createRes.errors?.map((e) => e.message).join('; ') || 'Failed to create zone');
          }
          cfZone = createRes.result;
          await send({ type: 'success', zone: zone.name, message: `Zone created (ID: ${cfZone.id})` });
        }

        zoneResult.nameServers = cfZone.name_servers || [];

        // Step 2: Get records (either from Azure, pre-scanned, or will be provided)
        let cfRecords;

        if (zone.source === 'azure' && body.azureToken) {
          // Read from Azure DNS
          await send({ type: 'status', zone: zone.name, message: 'Reading records from Azure DNS...' });

          let azureRecords = [];
          let url = `${AZURE_MGMT_URL}/subscriptions/${encodeURIComponent(body.subscriptionId)}/resourceGroups/${encodeURIComponent(zone.resourceGroup)}/providers/Microsoft.Network/dnsZones/${encodeURIComponent(zone.name)}/recordsets?api-version=${DNS_API_VERSION}&$top=500`;

          while (url) {
            const data = await azureFetch(body.azureToken, url);
            azureRecords.push(...data.value);
            url = data.nextLink || null;
          }

          await send({ type: 'info', zone: zone.name, message: `Found ${azureRecords.length} record sets in Azure` });

          const { records, skipped } = transformAzureRecords(azureRecords, zone.name);
          cfRecords = records;
          for (const s of skipped) {
            await send({ type: 'skip', zone: zone.name, message: `Skipped ${s.type} ${s.name}: ${s.reason}` });
            zoneResult.skippedRecords.push({ type: s.type, name: s.name, reason: s.reason });
          }
          zoneResult.skipped += skipped.length;

        } else if (zone.records) {
          // Records already provided (from DNS scan or manual)
          cfRecords = zone.records;
          await send({ type: 'info', zone: zone.name, message: `Using ${cfRecords.length} pre-scanned records` });
        } else {
          await send({ type: 'error', zone: zone.name, message: 'No record source configured' });
          zoneResult.status = 'failed';
        }

        if (!cfRecords || cfRecords.length === 0) {
          if (zoneResult.status !== 'failed') {
            await send({ type: 'info', zone: zone.name, message: 'No records to migrate' });
            zoneResult.status = 'complete';
          }
        } else {

        // Step 3: Check existing CF records
        await send({ type: 'status', zone: zone.name, message: 'Checking existing Cloudflare records...' });
        let existingRecords = [];
        let page = 1;
        while (true) {
          const data = await cfFetch(body.cfToken, 'GET', `/zones/${cfZone.id}/dns_records?per_page=100&page=${page}`);
          if (!data.success) break;
          existingRecords.push(...data.result);
          if (page >= data.result_info.total_pages) break;
          page++;
        }

        // Step 4: Push records
        await send({ type: 'status', zone: zone.name, message: `Pushing ${cfRecords.length} records to Cloudflare...` });

        for (let i = 0; i < cfRecords.length; i++) {
          const rec = cfRecords[i];
          const displayName = rec.name === '@' ? zone.name : `${rec.name}.${zone.name}`;
          const displayContent = rec.content || JSON.stringify(rec.data || {});

          // Duplicate check
          const isDup = existingRecords.some((er) => {
            const nameMatch = er.name === displayName || er.name === rec.name ||
              (rec.name === '@' && er.name === zone.name);
            return er.type === rec.type && nameMatch && (!rec.content || er.content === rec.content);
          });

          if (isDup) {
            await send({ type: 'skip', zone: zone.name, message: `[${i + 1}/${cfRecords.length}] ${rec.type} ${displayName} — already exists` });
            zoneResult.skipped++;
            zoneResult.skippedRecords.push({ type: rec.type, name: displayName, content: displayContent, reason: 'Already exists in Cloudflare' });
            continue;
          }

          const result = await cfFetch(body.cfToken, 'POST', `/zones/${cfZone.id}/dns_records`, rec);

          if (result.success) {
            await send({ type: 'record', zone: zone.name, message: `[${i + 1}/${cfRecords.length}] ${rec.type} ${displayName} → ${displayContent}` });
            zoneResult.created++;
          } else {
            const errMsg = result.errors?.map((e) => e.message).join('; ') || 'Unknown error';
            if (errMsg.includes('already exists')) {
              await send({ type: 'skip', zone: zone.name, message: `[${i + 1}/${cfRecords.length}] ${rec.type} ${displayName} — already exists` });
              zoneResult.skipped++;
              zoneResult.skippedRecords.push({ type: rec.type, name: displayName, content: displayContent, reason: 'Already exists in Cloudflare' });
            } else {
              await send({ type: 'error', zone: zone.name, message: `[${i + 1}/${cfRecords.length}] ${rec.type} ${displayName} — ${errMsg}` });
              zoneResult.failed++;
              zoneResult.errors.push(`${rec.type} ${displayName}: ${errMsg}`);
              zoneResult.failedRecords.push({ type: rec.type, name: displayName, content: displayContent, error: errMsg });
            }
          }
        }

        zoneResult.status = zoneResult.failed > 0 ? 'partial' : 'complete';
        } // end else (has records)
      } catch (err) {
        await send({ type: 'error', zone: zone.name, message: `Zone failed: ${err.message}` });
        zoneResult.status = 'failed';
        zoneResult.errors.push(err.message);
      }

      await send({ type: 'zone-complete', zone: zone.name, result: zoneResult });

    await send({ type: 'done', results: [zoneResult] });
    await writer.close();
  })();

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
