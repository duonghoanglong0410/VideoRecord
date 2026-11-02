import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DevHttpsCertBundle {
  key: Buffer;
  cert: Buffer;
  certPath: string;
  keyPath: string;
  lanIps: string[];
}

interface CertMetaFile {
  dnsNames: string[];
  ipAddresses: string[];
  createdAt: string;
  expiresAt: string;
}

function encodeDerLength(len: number): Buffer {
  if (len < 0x80) {
    return Buffer.from([len]);
  }
  const bytes: number[] = [];
  let remaining = len;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeDerLength(content.length), content]);
}

function derSequence(items: Buffer[]): Buffer {
  return derTlv(0x30, Buffer.concat(items));
}

function derSet(items: Buffer[]): Buffer {
  return derTlv(0x31, Buffer.concat(items));
}

function derExplicitContext(contextTagNumber: number, inner: Buffer): Buffer {
  return derTlv(0xa0 | contextTagNumber, inner);
}

function derBooleanTrue(): Buffer {
  return Buffer.from([0x01, 0x01, 0xff]);
}

function derSmallInteger(value: number): Buffer {
  return Buffer.from([0x02, 0x01, value & 0xff]);
}

function derPositiveIntegerBytes(raw: Buffer): Buffer {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) {
    start += 1;
  }
  const trimmed = raw.subarray(start);
  const body =
    (trimmed[0] & 0x80) !== 0
      ? Buffer.concat([Buffer.from([0x00]), trimmed])
      : trimmed;
  return derTlv(0x02, body);
}

function derBitString(payload: Buffer, unusedBits = 0): Buffer {
  return derTlv(0x03, Buffer.concat([Buffer.from([unusedBits & 0x07]), payload]));
}

function derOctetString(payload: Buffer): Buffer {
  return derTlv(0x04, payload);
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function derOid(dotNotation: string): Buffer {
  const parts = dotNotation.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length < 2) {
    throw new Error(`Invalid OID: ${dotNotation}`);
  }
  const out: number[] = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i += 1) {
    let val = parts[i];
    if (val === 0) {
      out.push(0);
      continue;
    }
    const base128: number[] = [];
    while (val > 0) {
      base128.unshift(val & 0x7f);
      val = Math.floor(val / 128);
    }
    for (let j = 0; j < base128.length - 1; j += 1) {
      base128[j] |= 0x80;
    }
    out.push(...base128);
  }
  return derTlv(0x06, Buffer.from(out));
}

function derUtf8String(text: string): Buffer {
  return derTlv(0x0c, Buffer.from(text, 'utf8'));
}

function derUtcTime(date: Date): Buffer {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return derTlv(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}

function derDistinguishedName(commonName: string, orgName: string): Buffer {
  const orgAttr = derSet([derSequence([derOid('2.5.4.10'), derUtf8String(orgName)])]);
  const cnAttr = derSet([derSequence([derOid('2.5.4.3'), derUtf8String(commonName)])]);
  return derSequence([orgAttr, cnAttr]);
}

function derExtension(oid: string, critical: boolean, extnValueDer: Buffer): Buffer {
  const parts: Buffer[] = [derOid(oid)];
  if (critical) {
    parts.push(derBooleanTrue());
  }
  parts.push(derOctetString(extnValueDer));
  return derSequence(parts);
}

function ipv4ToBuffer(ip: string): Buffer | null {
  const octets = ip.trim().split('.');
  if (octets.length !== 4) {
    return null;
  }
  const nums = octets.map((o) => Number.parseInt(o, 10));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return Buffer.from(nums);
}

function toPemBlock(label: string, der: Buffer): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export function detectLanIpv4Addresses(): string[] {
  const interfaces = os.networkInterfaces();
  const ips = new Set<string>();

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries || /WSL|vEthernet|Loopback|Docker/i.test(name)) {
      continue;
    }
    for (const entry of entries) {
      if (
        entry.family === 'IPv4' &&
        !entry.internal &&
        !entry.address.startsWith('127.') &&
        !entry.address.startsWith('169.254.')
      ) {
        ips.add(entry.address);
      }
    }
  }

  return [...ips].sort();
}

function buildSelfSignedX509Pem(options: {
  dnsNames: string[];
  ipAddresses: string[];
  notBefore: Date;
  notAfter: Date;
}): { keyPem: string; certPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  });

  const spkiDer = publicKey.export({
    type: 'spki',
    format: 'der'
  }) as Buffer;

  const pkcs8KeyPem = privateKey.export({
    type: 'pkcs8',
    format: 'pem'
  }) as string;

  // sha256WithRSAEncryption (1.2.840.113549.1.1.11)
  const algIdSha256WithRsa = derSequence([derOid('1.2.840.113549.1.1.11'), derNull()]);

  const serialBytes = crypto.randomBytes(16);
  serialBytes[0] &= 0x7f;
  if (serialBytes[0] === 0) {
    serialBytes[0] = 0x01;
  }

  const primaryLabel =
    options.ipAddresses.find((ip) => ip !== '127.0.0.1') ?? 'localhost';
  const subjectAndIssuer = derDistinguishedName(
    primaryLabel,
    'PackingProof Dev HTTPS'
  );

  const sanGeneralNames: Buffer[] = [];
  for (const dns of options.dnsNames) {
    // dNSName [2] IMPLICIT IA5String
    sanGeneralNames.push(derTlv(0x82, Buffer.from(dns, 'ascii')));
  }
  for (const ip of options.ipAddresses) {
    const ipBuf = ipv4ToBuffer(ip);
    if (ipBuf) {
      // iPAddress [7] IMPLICIT OCTET STRING
      sanGeneralNames.push(derTlv(0x87, ipBuf));
    }
  }

  // Extensions (RFC 5280 + Apple iOS <= 398-day TLS requirements)
  const basicConstraintsExt = derExtension('2.5.29.19', true, derSequence([]));
  // KeyUsage: digitalSignature (bit 0) | keyEncipherment (bit 2) => 0b1010_0000 (5 unused bits)
  const keyUsageExt = derExtension(
    '2.5.29.15',
    true,
    derBitString(Buffer.from([0xa0]), 5)
  );
  // ExtendedKeyUsage: id-kp-serverAuth (1.3.6.1.5.5.7.3.1)
  const extKeyUsageExt = derExtension(
    '2.5.29.37',
    false,
    derSequence([derOid('1.3.6.1.5.5.7.3.1')])
  );
  // SubjectAlternativeName (2.5.29.17)
  const sanExt = derExtension(
    '2.5.29.17',
    false,
    derSequence(sanGeneralNames)
  );

  const extensionsSeq = derSequence([
    basicConstraintsExt,
    keyUsageExt,
    extKeyUsageExt,
    sanExt
  ]);

  const tbsCertificate = derSequence([
    derExplicitContext(0, derSmallInteger(2)), // v3 (2)
    derPositiveIntegerBytes(serialBytes),
    algIdSha256WithRsa,
    subjectAndIssuer,
    derSequence([derUtcTime(options.notBefore), derUtcTime(options.notAfter)]),
    subjectAndIssuer,
    spkiDer,
    derExplicitContext(3, extensionsSeq)
  ]);

  const signature = crypto.sign('sha256', tbsCertificate, privateKey);
  const fullCertDer = derSequence([
    tbsCertificate,
    algIdSha256WithRsa,
    derBitString(signature, 0)
  ]);

  const certPem = toPemBlock('CERTIFICATE', fullCertDer);

  // Verify self-signature & X.509 parsing immediately using Node's OpenSSL X509Certificate
  const parsed = new crypto.X509Certificate(certPem);
  if (!parsed.verify(parsed.publicKey)) {
    throw new Error('Generated dev HTTPS X.509 certificate failed self-verification.');
  }

  return {
    keyPem: pkcs8KeyPem,
    certPem
  };
}

/**
 * Ensures a cached self-signed TLS certificate exists in `certDir` covering `localhost`,
 * `127.0.0.1`, and all active LAN IPv4 addresses (valid for 365 days to satisfy iOS Safari's
 * <= 398-day TLS limit). Regenerates automatically only when LAN IP changes or cert nears expiry.
 */
export function ensureDevHttpsCertificate(
  certDir = path.resolve(import.meta.dirname, '.certs')
): DevHttpsCertBundle {
  const lanIps = detectLanIpv4Addresses();
  const dnsNames = ['localhost'];
  const ipAddresses = ['127.0.0.1', ...lanIps];

  const certPath = path.join(certDir, 'dev-cert.pem');
  const keyPath = path.join(certDir, 'dev-key.pem');
  const metaPath = path.join(certDir, 'dev-cert-meta.json');

  try {
    if (
      fs.existsSync(certPath) &&
      fs.existsSync(keyPath) &&
      fs.existsSync(metaPath)
    ) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as CertMetaFile;
      const certBuf = fs.readFileSync(certPath);
      const keyBuf = fs.readFileSync(keyPath);
      const parsed = new crypto.X509Certificate(certBuf);
      const validToMs = Date.parse(parsed.validTo);
      const hasAtLeast30Days =
        Number.isFinite(validToMs) && validToMs - Date.now() > 30 * 86_400_000;
      const coversAllIps = ipAddresses.every((ip) =>
        meta.ipAddresses?.includes(ip)
      );
      const coversAllDns = dnsNames.every((d) => meta.dnsNames?.includes(d));

      if (hasAtLeast30Days && coversAllIps && coversAllDns) {
        return {
          key: keyBuf,
          cert: certBuf,
          certPath,
          keyPath,
          lanIps
        };
      }
    }
  } catch {
    // Regenerate cleanly below
  }

  fs.mkdirSync(certDir, { recursive: true });

  // 365 days total validity (-1 day to +364 days) satisfies Apple iOS/Safari <= 398-day TLS rule
  const now = Date.now();
  const notBefore = new Date(now - 86_400_000);
  const notAfter = new Date(now + 364 * 86_400_000);

  const { keyPem, certPem } = buildSelfSignedX509Pem({
    dnsNames,
    ipAddresses,
    notBefore,
    notAfter
  });

  fs.writeFileSync(certPath, certPem, { encoding: 'utf8' });
  fs.writeFileSync(keyPath, keyPem, { encoding: 'utf8' });

  const meta: CertMetaFile = {
    dnsNames,
    ipAddresses,
    createdAt: new Date(now).toISOString(),
    expiresAt: notAfter.toISOString()
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { encoding: 'utf8' });

  return {
    key: Buffer.from(keyPem, 'utf8'),
    cert: Buffer.from(certPem, 'utf8'),
    certPath,
    keyPath,
    lanIps
  };
}

