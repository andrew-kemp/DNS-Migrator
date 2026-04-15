import { jsonOk, jsonError, parseBody } from '../_helpers.js';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

async function cfFetch(apiToken, method, endpoint) {
  const res = await fetch(`${CF_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  });
  return res.json();
}

export async function onRequestPost({ request }) {
  const body = await parseBody(request);
  if (!body?.apiToken) return jsonError('API token is required');

  try {
    const verify = await cfFetch(body.apiToken, 'GET', '/user/tokens/verify');
    if (!verify.success) throw new Error('Invalid Cloudflare API token');

    const accounts = await cfFetch(body.apiToken, 'GET', '/accounts?per_page=50');
    if (!accounts.success || !accounts.result?.length) {
      throw new Error('Could not retrieve Cloudflare accounts. Ensure token has Account:Read permission.');
    }

    return jsonOk({
      success: true,
      accounts: accounts.result.map((a) => ({ id: a.id, name: a.name })),
    });
  } catch (err) {
    return jsonError(err.message);
  }
}
