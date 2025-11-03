#!/usr/bin/env node

const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const csvParser = require('csv-parser');
const axios = require('axios');

// ======================= CONFIG =======================
const SMTP_PORT = 25;
const RESPONSE_TIMEOUT = 10000;
const PROGRESS_FILE = 'progress.json';
const NEVERBOUNCE_API_KEY = 'private_64ec5d5c0d276ecec59d3802454071d9'; // 🔑 Replace with your real key
const RETRY_DELAY_MS = 2000; // for rate limits
// ======================================================

// ---------- Generate candidate patterns ----------
function generateEmailCandidates(fullName, domain) {
    const candidates = [];
    const base = domain.toLowerCase();
    if (fullName.includes(' ')) {
        const [first, ...rest] = fullName.trim().split(/\s+/);
        const last = rest[rest.length - 1];
        if (first && last) {
            candidates.push(`${first}@${base}`);
            candidates.push(`${first}.${last}@${base}`);
            candidates.push(`${first[0]}${last}@${base}`);
            candidates.push(`${first}${last[0]}@${base}`);
            candidates.push(`${first}${last}@${base}`);
            candidates.push(`${last}@${base}`);
        }
    } else {
        candidates.push(`${fullName.toLowerCase()}@${base}`);
    }
    return [...new Set(candidates.map(c => c.toLowerCase()))];
}

// ---------- Get MX Records ----------
async function getMxRecords(domain) {
    try {
        const records = await dns.resolveMx(domain);
        return records.sort((a, b) => a.priority - b.priority).map(r => r.exchange);
    } catch {
        return [];
    }
}

// ---------- Verify single email by SMTP ----------
async function verifySMTP(email, mxHosts) {
    if (!mxHosts.length) return { email, success: false, info: 'No MX' };
    for (const host of mxHosts) {
        const result = await new Promise(resolve => {
            const socket = net.createConnection({ host, port: SMTP_PORT });
            let stage = 0;
            let buffer = '';
            let resolved = false;

            const cleanup = () => {
                if (!resolved) {
                    resolved = true;
                    socket.destroy();
                    resolve({ email, success: false, info: 'SMTP closed' });
                }
            };

            socket.setTimeout(RESPONSE_TIMEOUT, cleanup);

            socket.on('data', data => {
                buffer += data.toString();
                const lines = buffer.split('\r\n');
                for (const line of lines) {
                    if (!line) continue;
                    if (stage === 0 && line.startsWith('220')) {
                        socket.write(`EHLO test.com\r\n`);
                        stage = 1;
                    } else if (stage === 1 && line.startsWith('250')) {
                        socket.write(`MAIL FROM:<test@test.com>\r\n`);
                        stage = 2;
                    } else if (stage === 2 && line.startsWith('250')) {
                        socket.write(`RCPT TO:<${email}>\r\n`);
                        stage = 3;
                    } else if (stage === 3) {
                        if (line.startsWith('250')) {
                            socket.write('QUIT\r\n');
                            resolve({ email, success: true, info: `SMTP accepted: ${host}` });
                        } else {
                            socket.write('QUIT\r\n');
                            resolve({ email, success: false, info: `SMTP rejected: ${line}` });
                        }
                        stage = 4;
                    }
                }
            });

            socket.on('error', () => resolve({ email, success: false, info: 'SMTP error' }));
            socket.on('close', cleanup);
        });
        if (result.success) return result;
    }
    return { email, success: false, info: 'All MX failed' };
}

// ---------- Detect Catch-All ----------
async function isCatchAll(domain, mxHosts) {
    const testEmail = `random_${Date.now()}@${domain}`;
    const res = await verifySMTP(testEmail, mxHosts);
    return res.success;
}

// ---------- Verify with NeverBounce ----------
async function verifyNeverBounce(email) {
    const url = `https://api.neverbounce.com/v4/single/check?key=${NEVERBOUNCE_API_KEY}&email=${encodeURIComponent(email)}&address_info=0&credits_info=0&timeout=15`;
    try {
        const { data } = await axios.get(url);
        if (data.result === 'valid') return { success: true, info: 'NeverBounce: valid' };
        if (data.result === 'catchall') return { success: false, info: 'NeverBounce: catch-all' };
        if (data.result === 'invalid') return { success: false, info: 'NeverBounce: invalid' };
        if (data.result === 'unknown') {
            // retry once after delay
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            const retry = await axios.get(url);
            return retry.data.result === 'valid'
                ? { success: true, info: 'NeverBounce: valid (retry)' }
                : { success: false, info: `NeverBounce: ${retry.data.result}` };
        }
        return { success: false, info: `NeverBounce: ${data.result}` };
    } catch (err) {
        return { success: false, info: `NeverBounce error: ${err.message}` };
    }
}

// ---------- Main CSV Processor ----------
async function processInputCSV(inputFile) {
    const entries = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(inputFile)
            .pipe(csvParser())
            .on('data', row => {
                if (row.domain && row.fullName) entries.push(row);
            })
            .on('end', resolve)
            .on('error', reject);
    });

    let progress = [];
    try {
        if (fs.existsSync(PROGRESS_FILE)) {
            progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8') || '[]');
        }
    } catch {
        progress = [];
    }

    const processedSet = new Set(progress.map(p => `${p.domain}||${p.name}`));
    const verified = [];

    for (const { domain, fullName } of entries) {
        const key = `${domain}||${fullName}`;
        if (processedSet.has(key)) continue;

        const candidates = generateEmailCandidates(fullName, domain);
        const mxHosts = await getMxRecords(domain);
        const catchAll = await isCatchAll(domain, mxHosts);

        console.log(`\n🔍 ${fullName} @ ${domain} ${catchAll ? '(Catch-All detected ⚠️)' : ''}`);
        let found = false;

        for (const email of candidates) {
            const smtp = await verifySMTP(email, mxHosts);
            console.log(`📡 SMTP: ${email} ➜ ${smtp.success ? '✅' : '❌'} (${smtp.info})`);
            if (!smtp.success) continue;

            const nb = await verifyNeverBounce(email);
            console.log(`🔎 NeverBounce: ${email} ➜ ${nb.success ? '✅' : '❌'} (${nb.info})`);

            if (nb.success) {
                verified.push({ name: fullName, domain, email, method: 'SMTP+NeverBounce' });
                console.log(`✅ FINAL: ${email} accepted\n`);
                found = true;
                break;
            }
        }

        if (!found) console.log(`❌ No valid email found for ${fullName}`);

        progress.push({
            name: fullName,
            domain,
            email: found ? verified[verified.length - 1].email : null,
            found,
            ts: Date.now()
        });
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        processedSet.add(key);
    }

    console.log(`\n✔️ Verified Emails Summary:\n`);
    verified.forEach(v => console.log(`${v.name} (${v.domain}): ${v.email}`));
}

// ---------- Run ----------
const file = process.argv[2] || 'input.csv';
processInputCSV(file).catch(err => console.error("❌ Error:", err));
