import { jsonError, parseBody } from '../_helpers.js';

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'];

const COMMON_SUBDOMAINS = [
  'www', 'mail', 'email', 'webmail', 'smtp', 'pop', 'imap',
  'ftp', 'api', 'app', 'dev', 'staging', 'test', 'beta',
  'blog', 'shop', 'store', 'cdn', 'media', 'static', 'assets', 'img',
  'admin', 'portal', 'dashboard', 'cpanel',
  'vpn', 'remote', 'rdp', 'ssh',
  'ns1', 'ns2', 'ns3', 'dns',
  'autodiscover', 'autoconfig', 'lyncdiscover', 'sip',
  'enterpriseregistration', 'enterpriseenrollment',
  '_dmarc',
  'docs', 'wiki', 'help', 'support', 'status',
  'git', 'ci',
  'db', 'mysql', 'postgres', 'redis',
  'office', 'exchange',
  'proxy', 'gateway', 'lb',
  'web', 'www2',
  'm', 'mobile',
  'login', 'auth', 'sso', 'id',
  'cloud',
];

const COMMON_SRV = [
  '_sip._tls', '_sip._tcp', '_sipfederationtls._tcp',
  '_xmpp-client._tcp', '_xmpp-server._tcp',
  '_imaps._tcp', '_submission._tcp', '_autodiscover._tcp',
  '_caldavs._tcp', '_carddavs._tcp',
];

const TYPE_MAP = { 1: 'A', 28: 'AAAA', 5: 'CNAME', 15: 'MX', 16: 'TXT', 2: 'NS', 33: 'SRV', 257: 'CAA' };

async function queryDoH(name, type) {
  try {
    const res = await fetch(
      `${DOH_URL}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { headers: { Accept: 'application/dns-json' } }
    );
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

function parseDohRecords(doh, zone) {
  if (!doh?.Answer) return [];
  const records = [];

  for (const ans of doh.Answer) {
    const fullName = ans.name.replace(/\.$/, '');
    const type = TYPE_MAP[ans.type];
    if (!type) continue;

    let name = fullName === zone ? '@' : fullName.endsWith(`.${zone}`) ? fullName.slice(0, -(zone.length + 1)) : fullName;
    const data = (ans.data || '').replace(/\.$/, '');
    const ttl = ans.TTL || 1;

    switch (type) {
      case 'A': case 'AAAA': case 'CNAME':
        records.push({ type, name, content: data, ttl, proxied: false });
        break;
      case 'MX': {
        const p = ans.data.split(/\s+/);
        records.push({ type: 'MX', name, content: (p[1] || '').replace(/\.$/, ''), priority: parseInt(p[0], 10) || 10, ttl });
        break;
      }
      case 'TXT':
        records.push({ type: 'TXT', name, content: data.replace(/^"|"$/g, ''), ttl });
        break;
      case 'NS':
        if (name !== '@') records.push({ type: 'NS', name, content: data, ttl });
        break;
      case 'SRV': {
        const p = ans.data.split(/\s+/);
        records.push({ type: 'SRV', name, ttl, data: { priority: parseInt(p[0]) || 0, weight: parseInt(p[1]) || 0, port: parseInt(p[2]) || 0, target: (p[3] || '').replace(/\.$/, '') } });
        break;
      }
      case 'CAA': {
        const p = ans.data.split(/\s+/);
        records.push({ type: 'CAA', name, ttl, data: { flags: parseInt(p[0]) || 0, tag: p[1] || '', value: (p[2] || '').replace(/^"|"$/g, '') } });
        break;
      }
    }
  }
  return records;
}

function dedup(records) {
  const seen = new Set();
  return records.filter((r) => {
    const k = `${r.type}|${r.name}|${r.content || ''}|${JSON.stringify(r.data || {})}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function onRequestPost({ request }) {
  const body = await parseBody(request);
  if (!body?.domain) return jsonError('Domain is required');

  const zone = body.domain.trim().toLowerCase().replace(/\.$/, '');

  // Use streaming NDJSON for real-time progress
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = async (event) => {
    await writer.write(encoder.encode(JSON.stringify(event) + '\n'));
  };

  // Run scan in background, stream results
  (async () => {
    try {
      let allRecords = [];
      const subdomainsFound = new Set();

      // Phase 1: apex
      await send({ type: 'status', message: `Scanning apex records for ${zone}...` });
      const apexResults = await Promise.all(RECORD_TYPES.map((t) => queryDoH(zone, t)));
      for (const r of apexResults) allRecords.push(...parseDohRecords(r, zone));
      await send({ type: 'info', message: `Found ${allRecords.length} apex records` });

      // Phase 2: subdomains (batch)
      await send({ type: 'status', message: `Probing ${COMMON_SUBDOMAINS.length} common subdomains...` });
      const BATCH = 10;
      for (let i = 0; i < COMMON_SUBDOMAINS.length; i += BATCH) {
        const batch = COMMON_SUBDOMAINS.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.flatMap((s) => [queryDoH(`${s}.${zone}`, 'A'), queryDoH(`${s}.${zone}`, 'AAAA'), queryDoH(`${s}.${zone}`, 'CNAME')])
        );
        for (let j = 0; j < batch.length; j++) {
          const sub = batch[j];
          const recs = [...parseDohRecords(results[j * 3], zone), ...parseDohRecords(results[j * 3 + 1], zone), ...parseDohRecords(results[j * 3 + 2], zone)];
          if (recs.length > 0) {
            subdomainsFound.add(sub);
            allRecords.push(...recs);
            const [mx, txt] = await Promise.all([queryDoH(`${sub}.${zone}`, 'MX'), queryDoH(`${sub}.${zone}`, 'TXT')]);
            allRecords.push(...parseDohRecords(mx, zone), ...parseDohRecords(txt, zone));
          }
        }
        await send({ type: 'progress', message: `Probed ${Math.min(i + BATCH, COMMON_SUBDOMAINS.length)}/${COMMON_SUBDOMAINS.length} subdomains (${subdomainsFound.size} found)` });
      }

      // Phase 3: SRV
      await send({ type: 'status', message: 'Probing SRV records...' });
      for (let i = 0; i < COMMON_SRV.length; i += BATCH) {
        const results = await Promise.all(COMMON_SRV.slice(i, i + BATCH).map((s) => queryDoH(`${s}.${zone}`, 'SRV')));
        for (const r of results) allRecords.push(...parseDohRecords(r, zone));
      }

      allRecords = dedup(allRecords);
      await send({ type: 'done', records: allRecords, subdomainsFound: [...subdomainsFound], total: allRecords.length });
    } catch (err) {
      await send({ type: 'error', message: err.message });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
