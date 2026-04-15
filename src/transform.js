/**
 * Transforms Azure DNS REST API record sets into Cloudflare API format.
 */

function transformRecordName(fqdn, zoneName) {
  const name = fqdn.replace(/\.$/, '');
  if (name === zoneName) return '@';
  const suffix = `.${zoneName}`;
  if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  if (name === '@') return '@';
  return name;
}

function stripDot(s) {
  return s ? s.replace(/\.$/, '') : s;
}

function transformRecords(azureRecordSets, zoneName) {
  const records = [];
  const skipped = [];

  for (const rs of azureRecordSets) {
    const type = rs.type.split('/').pop().toUpperCase();
    const name = rs.name || transformRecordName(rs.properties?.fqdn || '', zoneName);
    const props = rs.properties || rs;
    const ttl = (props.TTL || props.ttl || 1);

    if (type === 'SOA') {
      skipped.push({ type, name, reason: 'Cloudflare manages SOA' });
      continue;
    }
    if (type === 'NS' && (name === '@' || name === zoneName)) {
      skipped.push({ type, name: '@', reason: 'Cloudflare manages apex NS' });
      continue;
    }

    // A records
    const aRecords = props.ARecords || props.aRecords || [];
    if (type === 'A') {
      for (const r of aRecords) {
        records.push({ type: 'A', name, content: r.ipv4Address, ttl, proxied: false });
      }
    }

    // AAAA records
    const aaaaRecords = props.AAAARecords || props.aaaaRecords || [];
    if (type === 'AAAA') {
      for (const r of aaaaRecords) {
        records.push({ type: 'AAAA', name, content: r.ipv6Address, ttl, proxied: false });
      }
    }

    // CNAME record (singular in Azure)
    if (type === 'CNAME') {
      const cname = props.CNAMERecord || props.cnameRecord || props.CnameRecord;
      if (cname?.cname) {
        records.push({ type: 'CNAME', name, content: stripDot(cname.cname), ttl, proxied: false });
      }
    }

    // MX records
    const mxRecords = props.MXRecords || props.mxRecords || [];
    if (type === 'MX') {
      for (const r of mxRecords) {
        records.push({ type: 'MX', name, content: stripDot(r.exchange), priority: r.preference, ttl });
      }
    }

    // TXT records
    const txtRecords = props.TXTRecords || props.txtRecords || [];
    if (type === 'TXT') {
      for (const r of txtRecords) {
        const value = Array.isArray(r.value) ? r.value.join('') : r.value;
        records.push({ type: 'TXT', name, content: value, ttl });
      }
    }

    // SRV records
    const srvRecords = props.SRVRecords || props.srvRecords || [];
    if (type === 'SRV') {
      for (const r of srvRecords) {
        records.push({
          type: 'SRV', name, ttl,
          data: { priority: r.priority, weight: r.weight, port: r.port, target: stripDot(r.target) },
        });
      }
    }

    // CAA records
    const caaRecords = props.CAARecords || props.caaRecords || [];
    if (type === 'CAA') {
      for (const r of caaRecords) {
        records.push({
          type: 'CAA', name, ttl,
          data: { flags: r.flags, tag: r.tag, value: r.value },
        });
      }
    }

    // NS records (non-apex only — apex already skipped above)
    const nsRecords = props.NSRecords || props.nsRecords || [];
    if (type === 'NS') {
      for (const r of nsRecords) {
        records.push({ type: 'NS', name, content: stripDot(r.nsdname), ttl });
      }
    }

    // PTR records
    const ptrRecords = props.PTRRecords || props.ptrRecords || [];
    if (type === 'PTR') {
      for (const r of ptrRecords) {
        records.push({ type: 'PTR', name, content: stripDot(r.ptrdname), ttl });
      }
    }
  }

  return { records, skipped };
}

module.exports = { transformRecords };
