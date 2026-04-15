import { jsonOk, jsonError, parseBody } from '../_helpers.js';

const AZURE_MGMT_URL = 'https://management.azure.com';
const DNS_API_VERSION = '2018-05-01';

export async function onRequestPost({ request }) {
  const body = await parseBody(request);
  if (!body?.token || !body?.subscriptionId) {
    return jsonError('Token and subscription ID are required');
  }

  try {
    let zones = [];
    let url = `${AZURE_MGMT_URL}/subscriptions/${encodeURIComponent(body.subscriptionId)}/providers/Microsoft.Network/dnszones?api-version=${DNS_API_VERSION}`;

    while (url) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${body.token}` },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Azure API error (${res.status})`);
      }

      const data = await res.json();
      for (const z of data.value) {
        const rgMatch = z.id.match(/resourceGroups\/([^/]+)\//i);
        zones.push({
          name: z.name,
          resourceGroup: rgMatch ? rgMatch[1] : '',
          numberOfRecordSets: z.properties?.numberOfRecordSets || 0,
        });
      }
      url = data.nextLink || null;
    }

    return jsonOk({ success: true, zones });
  } catch (err) {
    return jsonError(err.message);
  }
}
