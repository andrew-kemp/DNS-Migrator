/**
 * Universal DNS record scanner using DNS-over-HTTPS.
 * Works with ANY DNS provider — no API credentials needed.
 * Queries Cloudflare DoH to discover records.
 */

const DOH_URL = 'https://cloudflare-dns.com/dns-query';

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'PTR'];

// Common subdomains to probe — most hosted sites use a subset of these
const COMMON_SUBDOMAINS = [
  'www', 'mail', 'email', 'webmail', 'smtp', 'pop', 'imap',
  'ftp', 'sftp',
  'api', 'app', 'dev', 'staging', 'test', 'beta', 'demo',
  'blog', 'shop', 'store', 'cdn', 'media', 'static', 'assets', 'img', 'images',
  'admin', 'portal', 'dashboard', 'panel', 'cpanel', 'whm',
  'vpn', 'remote', 'rdp', 'ssh',
  'ns1', 'ns2', 'ns3', 'dns', 'dns1', 'dns2',
  'mx', 'mx1', 'mx2',
  'autodiscover', 'autoconfig', 'lyncdiscover', 'sip', 'enterpriseregistration', 'enterpriseenrollment',
  '_dmarc', '_domainkey',
  'calendar', 'cal',
  'docs', 'wiki', 'help', 'support', 'status',
  'git', 'gitlab', 'ci', 'jenkins', 'build',
  'db', 'database', 'mysql', 'postgres', 'redis', 'mongo',
  'office', 'exchange', 'owa',
  'proxy', 'gateway', 'lb', 'load',
  'host', 'server', 'web', 'www2',
  'intranet', 'internal',
  'm', 'mobile',
  'link', 'links', 'go', 'redirect',
  'news', 'newsletter',
  'crm', 'erp',
  'login', 'auth', 'sso', 'id', 'identity',
  'cloud', 'aws', 'azure', 'gcp',
];

// SRV records to probe
const COMMON_SRV = [
  '_sip._tls', '_sip._tcp', '_sip._udp',
  '_sipfederationtls._tcp',
  '_xmpp-client._tcp', '_xmpp-server._tcp',
  '_imap._tcp', '_imaps._tcp',
  '_pop3._tcp', '_pop3s._tcp',
  '_submission._tcp',
  '_autodiscover._tcp',
  '_caldav._tcp', '_caldavs._tcp',
  '_carddav._tcp', '_carddavs._tcp',
  '_http._tcp', '_https._tcp',
  '_minecraft._tcp',
];

async function queryDoH(name, type) {
  const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch {
    return null;
  }
}

function parseDohRecords(dohResponse, zoneName) {
  if (!dohResponse?.Answer) return [];

  const records = [];
  for (const ans of dohResponse.Answer) {
    const fullName = ans.name.replace(/\.$/, '');
    const type = typeNumberToString(ans.type);
    if (!type) continue;

    // Calculate relative name
    let name;
    if (fullName === zoneName) {
      name = '@';
    } else if (fullName.endsWith(`.${zoneName}`)) {
      name = fullName.slice(0, -(zoneName.length + 1));
    } else {
      name = fullName;
    }

    const data = ans.data?.replace(/\.$/, '') || '';
    const ttl = ans.TTL || 1;

    switch (type) {
      case 'A':
      case 'AAAA':
        records.push({ type, name, content: data, ttl, proxied: false });
        break;
      case 'CNAME':
        records.push({ type, name, content: data, ttl, proxied: false });
        break;
      case 'MX': {
        const parts = ans.data.split(/\s+/);
        const priority = parseInt(parts[0], 10) || 10;
        const exchange = (parts[1] || '').replace(/\.$/, '');
        records.push({ type: 'MX', name, content: exchange, priority, ttl });
        break;
      }
      case 'TXT':
        // DoH returns TXT with quotes, strip them
        records.push({ type: 'TXT', name, content: data.replace(/^"|"$/g, ''), ttl });
        break;
      case 'NS':
        // Skip apex NS — Cloudflare manages its own
        if (name !== '@') {
          records.push({ type: 'NS', name, content: data, ttl });
        }
        break;
      case 'SRV': {
        const parts = ans.data.split(/\s+/);
        records.push({
          type: 'SRV', name, ttl,
          data: {
            priority: parseInt(parts[0], 10) || 0,
            weight: parseInt(parts[1], 10) || 0,
            port: parseInt(parts[2], 10) || 0,
            target: (parts[3] || '').replace(/\.$/, ''),
          },
        });
        break;
      }
      case 'CAA': {
        const parts = ans.data.split(/\s+/);
        records.push({
          type: 'CAA', name, ttl,
          data: {
            flags: parseInt(parts[0], 10) || 0,
            tag: parts[1] || '',
            value: (parts[2] || '').replace(/^"|"$/g, ''),
          },
        });
        break;
      }
    }
  }

  return records;
}

function typeNumberToString(num) {
  const map = { 1: 'A', 28: 'AAAA', 5: 'CNAME', 15: 'MX', 16: 'TXT', 2: 'NS', 33: 'SRV', 257: 'CAA', 12: 'PTR' };
  return map[num] || null;
}

function deduplicateRecords(records) {
  const seen = new Set();
  return records.filter((r) => {
    const key = `${r.type}|${r.name}|${r.content || ''}|${JSON.stringify(r.data || {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Scans a domain for DNS records using DoH.
 * @param {string} zoneName - The domain to scan (e.g., "andykemp.com")
 * @param {function} onProgress - Callback for progress updates: (message, phase) => void
 * @returns {Promise<{records: Array, subdomainsFound: string[]}>}
 */
async function scanDomain(zoneName, onProgress = () => {}) {
  let allRecords = [];
  const subdomainsFound = new Set();

  // Phase 1: Scan apex for all record types
  onProgress(`Scanning apex records for ${zoneName}...`, 'apex');

  const apexResults = await Promise.all(
    RECORD_TYPES.map((type) => queryDoH(zoneName, type))
  );

  for (const result of apexResults) {
    allRecords.push(...parseDohRecords(result, zoneName));
  }

  onProgress(`Found ${allRecords.length} apex records`, 'apex');

  // Phase 2: TXT record analysis — look for SPF includes, DKIM hints
  const txtRecords = allRecords.filter((r) => r.type === 'TXT');
  const extraSubdomains = new Set();

  for (const txt of txtRecords) {
    // SPF includes might hint at mail subdomains
    const includes = txt.content.match(/include:([^\s]+)/g);
    if (includes) {
      for (const inc of includes) {
        const domain = inc.replace('include:', '');
        if (domain.endsWith(`.${zoneName}`)) {
          extraSubdomains.add(domain.replace(`.${zoneName}`, ''));
        }
      }
    }
  }

  // Add any discovered subdomains to the probe list
  const subdomainsToProbe = [...new Set([...COMMON_SUBDOMAINS, ...extraSubdomains])];

  // Phase 3: Probe common subdomains (in batches to avoid rate limits)
  onProgress(`Probing ${subdomainsToProbe.length} common subdomains...`, 'subdomains');

  const BATCH_SIZE = 10;
  for (let i = 0; i < subdomainsToProbe.length; i += BATCH_SIZE) {
    const batch = subdomainsToProbe.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.flatMap((sub) => [
        queryDoH(`${sub}.${zoneName}`, 'A'),
        queryDoH(`${sub}.${zoneName}`, 'AAAA'),
        queryDoH(`${sub}.${zoneName}`, 'CNAME'),
      ])
    );

    for (let j = 0; j < batch.length; j++) {
      const sub = batch[j];
      const aResult = batchResults[j * 3];
      const aaaaResult = batchResults[j * 3 + 1];
      const cnameResult = batchResults[j * 3 + 2];

      const subRecords = [
        ...parseDohRecords(aResult, zoneName),
        ...parseDohRecords(aaaaResult, zoneName),
        ...parseDohRecords(cnameResult, zoneName),
      ];

      if (subRecords.length > 0) {
        subdomainsFound.add(sub);
        allRecords.push(...subRecords);

        // If we found this subdomain, also check MX and TXT
        const [mxResult, txtResult] = await Promise.all([
          queryDoH(`${sub}.${zoneName}`, 'MX'),
          queryDoH(`${sub}.${zoneName}`, 'TXT'),
        ]);
        allRecords.push(...parseDohRecords(mxResult, zoneName));
        allRecords.push(...parseDohRecords(txtResult, zoneName));
      }
    }

    onProgress(`Probed ${Math.min(i + BATCH_SIZE, subdomainsToProbe.length)}/${subdomainsToProbe.length} subdomains (found ${subdomainsFound.size})...`, 'subdomains');
  }

  // Phase 4: Probe common SRV records
  onProgress('Probing SRV records...', 'srv');

  for (let i = 0; i < COMMON_SRV.length; i += BATCH_SIZE) {
    const batch = COMMON_SRV.slice(i, i + BATCH_SIZE);
    const srvResults = await Promise.all(
      batch.map((srv) => queryDoH(`${srv}.${zoneName}`, 'SRV'))
    );
    for (const result of srvResults) {
      allRecords.push(...parseDohRecords(result, zoneName));
    }
  }

  // Deduplicate
  allRecords = deduplicateRecords(allRecords);

  onProgress(`Scan complete: ${allRecords.length} unique records found across ${subdomainsFound.size} subdomains`, 'done');

  return {
    records: allRecords,
    subdomainsFound: [...subdomainsFound],
  };
}

module.exports = { scanDomain, queryDoH, parseDohRecords, COMMON_SUBDOMAINS };
