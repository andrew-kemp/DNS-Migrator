const AZURE_AUTH_URL = 'https://login.microsoftonline.com';
const AZURE_MGMT_URL = 'https://management.azure.com';
const DNS_API_VERSION = '2018-05-01';
const SUB_API_VERSION = '2022-01-01';

async function getTokenFromServicePrincipal(tenantId, clientId, clientSecret) {
  const url = `${AZURE_AUTH_URL}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://management.azure.com/.default',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || `Azure auth failed (${res.status})`);
  }

  const data = await res.json();
  return data.access_token;
}

async function azureFetch(token, path) {
  const url = path.startsWith('http') ? path : `${AZURE_MGMT_URL}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || `Azure API error (${res.status})`;
    throw new Error(msg);
  }

  return res.json();
}

async function listSubscriptions(token) {
  const data = await azureFetch(token, `/subscriptions?api-version=${SUB_API_VERSION}`);
  return data.value.map((s) => ({
    id: s.subscriptionId,
    name: s.displayName,
    state: s.state,
  }));
}

async function listDnsZones(token, subscriptionId) {
  let zones = [];
  let url = `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Network/dnszones?api-version=${DNS_API_VERSION}`;

  while (url) {
    const data = await azureFetch(token, url);
    for (const z of data.value) {
      // Extract resource group from the zone's id
      const rgMatch = z.id.match(/resourceGroups\/([^/]+)\//i);
      zones.push({
        name: z.name,
        resourceGroup: rgMatch ? rgMatch[1] : '',
        numberOfRecordSets: z.properties?.numberOfRecordSets || 0,
      });
    }
    url = data.nextLink || null;
  }

  return zones;
}

async function listRecordSets(token, subscriptionId, resourceGroup, zoneName) {
  let records = [];
  let url = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Network/dnsZones/${encodeURIComponent(zoneName)}/recordsets?api-version=${DNS_API_VERSION}&$top=500`;

  while (url) {
    const data = await azureFetch(token, url);
    records.push(...data.value);
    url = data.nextLink || null;
  }

  return records;
}

module.exports = {
  getTokenFromServicePrincipal,
  listSubscriptions,
  listDnsZones,
  listRecordSets,
};
