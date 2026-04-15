const { Router } = require('express');
const azure = require('./azure');
const cloudflare = require('./cloudflare');
const { transformRecords } = require('./transform');
const { scanDomain } = require('./dns-scan');

const router = Router();

// ── Cloudflare: validate token ──────────────────────────────────────────────

router.post('/cloudflare/validate', async (req, res) => {
  try {
    const { apiToken } = req.body;
    if (!apiToken) return res.status(400).json({ error: 'API token is required' });

    const result = await cloudflare.validateToken(apiToken);
    res.json({ success: true, accounts: result.accounts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Azure: validate credentials ─────────────────────────────────────────────

router.post('/azure/validate', async (req, res) => {
  try {
    const { authMethod } = req.body;
    let token;

    if (authMethod === 'servicePrincipal') {
      const { tenantId, clientId, clientSecret } = req.body;
      if (!tenantId || !clientId || !clientSecret) {
        return res.status(400).json({ error: 'Tenant ID, Client ID, and Client Secret are required' });
      }
      token = await azure.getTokenFromServicePrincipal(tenantId, clientId, clientSecret);
    } else if (authMethod === 'bearerToken') {
      token = req.body.bearerToken;
      if (!token) return res.status(400).json({ error: 'Bearer token is required' });
    } else {
      return res.status(400).json({ error: 'Invalid auth method' });
    }

    const subscriptions = await azure.listSubscriptions(token);
    res.json({ success: true, token, subscriptions });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Azure: list DNS zones ───────────────────────────────────────────────────

router.post('/azure/zones', async (req, res) => {
  try {
    const { token, subscriptionId } = req.body;
    if (!token || !subscriptionId) {
      return res.status(400).json({ error: 'Token and subscription ID are required' });
    }

    const zones = await azure.listDnsZones(token, subscriptionId);
    res.json({ success: true, zones });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── DNS Scan: scan domain via DNS-over-HTTPS ────────────────────────────────

router.post('/dns/scan', async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain is required' });

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');

  const send = (event) => res.write(JSON.stringify(event) + '\n');

  try {
    const result = await scanDomain(domain.trim().toLowerCase(), (message, phase) => {
      send({ type: phase === 'done' ? 'info' : 'progress', message });
    });
    send({ type: 'done', records: result.records, total: result.records.length, subdomainsFound: result.subdomainsFound });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  res.end();
});

// ── Migrate: stream progress via NDJSON ─────────────────────────────────────

router.post('/migrate', async (req, res) => {
  const { cfToken, cfAccountId, zone, zones: zonesArray } = req.body;
  const zones = zone ? [zone] : zonesArray;

  if (!cfToken || !cfAccountId || !zones?.length) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');

  const send = (event) => res.write(JSON.stringify(event) + '\n');

  const results = [];

  for (const zone of zones) {
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
      send({ type: 'status', zone: zone.name, message: 'Creating zone in Cloudflare...' });

      const { zone: cfZone, alreadyExisted } = await cloudflare.createZone(cfToken, cfAccountId, zone.name);
      zoneResult.nameServers = cfZone.name_servers || [];

      if (alreadyExisted) {
        send({ type: 'info', zone: zone.name, message: 'Zone already exists in Cloudflare — adding records to it' });
      } else {
        send({ type: 'success', zone: zone.name, message: `Zone created (ID: ${cfZone.id})` });
      }

      // Step 2: Get records based on source
      let cfRecords;

      if (zone.source === 'azure' && req.body.azureToken) {
        send({ type: 'status', zone: zone.name, message: 'Reading records from Azure DNS...' });
        const azureRecordSets = await azure.listRecordSets(
          req.body.azureToken, req.body.subscriptionId, zone.resourceGroup, zone.name
        );
        send({ type: 'info', zone: zone.name, message: `Found ${azureRecordSets.length} record sets in Azure` });

        const { records, skipped } = transformRecords(azureRecordSets, zone.name);
        cfRecords = records;
        for (const s of skipped) {
          send({ type: 'skip', zone: zone.name, message: `Skipped ${s.type} ${s.name}: ${s.reason}` });
          zoneResult.skippedRecords.push({ type: s.type, name: s.name, reason: s.reason });
        }
        zoneResult.skipped += skipped.length;

      } else if (zone.records && zone.records.length > 0) {
        cfRecords = zone.records;
        send({ type: 'info', zone: zone.name, message: `Using ${cfRecords.length} pre-scanned records` });

      } else {
        // Manual — no records to import
        send({ type: 'info', zone: zone.name, message: 'No records to import (manual mode)' });
        zoneResult.status = 'complete';
        results.push(zoneResult);
        send({ type: 'zone-complete', zone: zone.name, result: zoneResult });
        continue;
      }

      if (!cfRecords || cfRecords.length === 0) {
        send({ type: 'info', zone: zone.name, message: 'No records to migrate' });
        zoneResult.status = 'complete';
        results.push(zoneResult);
        send({ type: 'zone-complete', zone: zone.name, result: zoneResult });
        continue;
      }

      // Step 3: Get existing CF records
      send({ type: 'status', zone: zone.name, message: 'Checking existing Cloudflare records...' });
      const existingRecords = await cloudflare.listDnsRecords(cfToken, cfZone.id);

      // Step 4: Push records
      send({ type: 'status', zone: zone.name, message: `Pushing ${cfRecords.length} records to Cloudflare...` });

      for (let i = 0; i < cfRecords.length; i++) {
        const rec = cfRecords[i];
        const displayName = rec.name === '@' ? zone.name : `${rec.name}.${zone.name}`;
        const displayContent = rec.content || JSON.stringify(rec.data || {});

        const isDuplicate = existingRecords.some((er) => {
          const nameMatch = er.name === displayName || er.name === rec.name ||
            (rec.name === '@' && er.name === zone.name);
          return er.type === rec.type && nameMatch && (!rec.content || er.content === rec.content);
        });

        if (isDuplicate) {
          send({ type: 'skip', zone: zone.name, message: `[${i + 1}/${cfRecords.length}] ${rec.type} ${displayName} — already exists` });
          zoneResult.skipped++;
          zoneResult.skippedRecords.push({ type: rec.type, name: displayName, content: displayContent, reason: 'Already exists in Cloudflare' });
          continue;
        }

        const result = await cloudflare.createDnsRecord(cfToken, cfZone.id, rec);

        if (result.success) {
          send({ type: 'record', zone: zone.name, message: `[${i + 1}/${cfRecords.length}] ${rec.type} ${displayName} → ${displayContent}` });
          zoneResult.created++;
        } else {
          const errMsg = result.errors?.map((e) => e.message).join('; ') || 'Unknown error';
          if (errMsg.includes('already exists')) {
            send({ type: 'skip', zone: zone.name, message: `[${i + 1}/${cfRecords.length}] ${rec.type} ${displayName} — already exists` });
            zoneResult.skipped++;
            zoneResult.skippedRecords.push({ type: rec.type, name: displayName, content: displayContent, reason: 'Already exists in Cloudflare' });
          } else {
            send({ type: 'error', zone: zone.name, message: `[${i + 1}/${cfRecords.length}] ${rec.type} ${displayName} — ${errMsg}` });
            zoneResult.failed++;
            zoneResult.errors.push(`${rec.type} ${displayName}: ${errMsg}`);
            zoneResult.failedRecords.push({ type: rec.type, name: displayName, content: displayContent, error: errMsg });
          }
        }
      }

      zoneResult.status = zoneResult.failed > 0 ? 'partial' : 'complete';
    } catch (err) {
      send({ type: 'error', zone: zone.name, message: `Zone failed: ${err.message}` });
      zoneResult.status = 'failed';
      zoneResult.errors.push(err.message);
    }

    results.push(zoneResult);
    send({ type: 'zone-complete', zone: zone.name, result: zoneResult });
  }

  send({ type: 'done', results });
  res.end();
});

module.exports = router;
