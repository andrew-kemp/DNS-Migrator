const CF_BASE = 'https://api.cloudflare.com/client/v4';

async function cfFetch(apiToken, method, endpoint, body) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${CF_BASE}${endpoint}`, opts);
  const data = await res.json();
  return data;
}

async function validateToken(apiToken) {
  const verify = await cfFetch(apiToken, 'GET', '/user/tokens/verify');
  if (!verify.success) {
    throw new Error('Invalid Cloudflare API token');
  }

  // Get account info
  const accounts = await cfFetch(apiToken, 'GET', '/accounts?per_page=50');
  if (!accounts.success || !accounts.result?.length) {
    throw new Error('Could not retrieve Cloudflare accounts. Ensure token has Account:Read permission.');
  }

  return {
    accounts: accounts.result.map((a) => ({ id: a.id, name: a.name })),
  };
}

async function findZone(apiToken, zoneName) {
  const data = await cfFetch(apiToken, 'GET', `/zones?name=${encodeURIComponent(zoneName)}`);
  if (data.success && data.result?.length > 0) {
    return data.result[0];
  }
  return null;
}

async function createZone(apiToken, accountId, zoneName) {
  // Check if zone already exists
  const existing = await findZone(apiToken, zoneName);
  if (existing) {
    return {
      zone: existing,
      alreadyExisted: true,
    };
  }

  const data = await cfFetch(apiToken, 'POST', '/zones', {
    name: zoneName,
    account: { id: accountId },
    type: 'full',
  });

  if (!data.success) {
    const errs = data.errors?.map((e) => e.message).join('; ') || 'Unknown error';
    throw new Error(`Failed to create zone ${zoneName}: ${errs}`);
  }

  return {
    zone: data.result,
    alreadyExisted: false,
  };
}

async function listDnsRecords(apiToken, zoneId) {
  let allRecords = [];
  let page = 1;

  while (true) {
    const data = await cfFetch(apiToken, 'GET', `/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
    if (!data.success) break;
    allRecords.push(...data.result);
    if (page >= data.result_info.total_pages) break;
    page++;
  }

  return allRecords;
}

async function createDnsRecord(apiToken, zoneId, record) {
  const data = await cfFetch(apiToken, 'POST', `/zones/${zoneId}/dns_records`, record);
  return data;
}

module.exports = {
  validateToken,
  findZone,
  createZone,
  listDnsRecords,
  createDnsRecord,
};
