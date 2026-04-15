import { jsonOk, jsonError, parseBody } from '../_helpers.js';

const AZURE_AUTH_URL = 'https://login.microsoftonline.com';
const AZURE_MGMT_URL = 'https://management.azure.com';
const SUB_API_VERSION = '2022-01-01';

export async function onRequestPost({ request }) {
  const body = await parseBody(request);
  if (!body) return jsonError('Invalid request body');

  try {
    let token;

    if (body.authMethod === 'servicePrincipal') {
      const { tenantId, clientId, clientSecret } = body;
      if (!tenantId || !clientId || !clientSecret) {
        return jsonError('Tenant ID, Client ID, and Client Secret are required');
      }

      const url = `${AZURE_AUTH_URL}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://management.azure.com/.default',
      });

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error_description || `Azure auth failed (${res.status})`);
      }

      const data = await res.json();
      token = data.access_token;
    } else if (body.authMethod === 'bearerToken') {
      token = body.bearerToken;
      if (!token) return jsonError('Bearer token is required');
    } else {
      return jsonError('Invalid auth method');
    }

    // List subscriptions
    const subRes = await fetch(
      `${AZURE_MGMT_URL}/subscriptions?api-version=${SUB_API_VERSION}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!subRes.ok) {
      const err = await subRes.json().catch(() => ({}));
      throw new Error(err.error?.message || `Azure API error (${subRes.status})`);
    }

    const subData = await subRes.json();
    const subscriptions = subData.value.map((s) => ({
      id: s.subscriptionId,
      name: s.displayName,
      state: s.state,
    }));

    return jsonOk({ success: true, token, subscriptions });
  } catch (err) {
    return jsonError(err.message);
  }
}
