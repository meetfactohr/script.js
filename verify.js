#!/usr/bin/env node

/**
 * Email Finder + Validator Script (EmailAwesome Bulk API Version)
 * ---------------------------------------------------------------
 * Inputs:  CSV file with columns => fullName, domain
 * Outputs: output_verified.csv containing verified email results
 *
 * Process:
 *  1. Generate possible email patterns from name + domain.
 *  2. SMTP verify each pattern.
 *  3. Bulk validate via EmailAwesome API (x-api-key header, webhook callback).
 *  4. Save valid ones to output.csv.
 */

const dns = require("dns").promises;
const net = require("net");
const fs = require("fs");
const csvParser = require("csv-parser");
const axios = require("axios");
const { stringify } = require("csv-stringify/sync");

// ---------------- CONFIG ----------------
const SMTP_PORT = 25;
const RESPONSE_TIMEOUT = 10000;
const EMAILAWESOME_API_KEY =
  process.env.EMAILAWESOME_API_KEY ||
  "92Vx96r13Z6zOobZzxQjmupkJ7h16HU7roOBBEKh";
const EMAILAWESOME_CALLBACK_URL =
  process.env.EMAILAWESOME_CALLBACK_URL ||
  "https://webhook.site/fb9724c7-911c-49f4-bc19-9e54c47df363";
const EMAILAWESOME_BEARER =
  process.env.EMAILAWESOME_BEARER || "Bearer xxxx";
const EMAILAWESOME_POLL_ATTEMPTS = 10;
const EMAILAWESOME_POLL_INTERVAL = 3000; // ms
const INPUT_FILE = process.argv[2] || "input.csv";
const PROGRESS_FILE = "progress.json";
const OUTPUT_FILE = "output_verified.csv";
// ----------------------------------------

// Generate email patterns
function generateEmailCandidates(fullName, domain) {
  const base = domain.toLowerCase();
  const names = fullName.trim().split(/\s+/);
  const first = names[0] || "";
  const last = names[names.length - 1] || "";
  const list = new Set();

  list.add(`${first}@${base}`);
  list.add(`${first}.${last}@${base}`);
  list.add(`${first[0]}${last}@${base}`);
  list.add(`${first}${last[0]}@${base}`);
  list.add(`${first}${last}@${base}`);
  list.add(`${last}@${base}`);
  list.add(`${first[0]}.${last}@${base}`);
  list.add(`${first}.${last[0]}@${base}`);

  return [...list].map((e) => e.toLowerCase());
}

// DNS MX lookup
async function getMxRecords(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange);
  } catch {
    return [];
  }
}

// SMTP verification
async function verifySMTP(email, mxHosts) {
  if (!mxHosts.length) return { email, success: false, info: "No MX" };
  for (const host of mxHosts) {
    const result = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port: SMTP_PORT });
      let stage = 0,
        buffer = "",
        done = false;

      const end = (ok, info) => {
        if (!done) {
          done = true;
          socket.destroy();
          resolve({ email, success: ok, info });
        }
      };

      socket.setTimeout(RESPONSE_TIMEOUT, () => end(false, "Timeout"));
      socket.on("data", (d) => {
        buffer += d.toString();
        const lines = buffer.split("\r\n");
        for (const line of lines) {
          if (!line) continue;
          if (stage === 0 && line.startsWith("220")) {
            socket.write(`EHLO test.com\r\n`);
            stage = 1;
          } else if (stage === 1 && line.startsWith("250")) {
            socket.write(`MAIL FROM:<test@test.com>\r\n`);
            stage = 2;
          } else if (stage === 2 && line.startsWith("250")) {
            socket.write(`RCPT TO:<${email}>\r\n`);
            stage = 3;
          } else if (stage === 3) {
            if (line.startsWith("250")) end(true, `SMTP accepted ${host}`);
            else end(false, line);
            stage = 4;
          }
        }
      });
      socket.on("error", (err) => end(false, "SMTP error: " + err.message));
      socket.on("close", () => end(false, "Closed"));
    });
    if (result.success) return result;
  }
  return { email, success: false, info: "All MX failed" };
}

// EmailAwesome bulk validation
// Validate with EmailAwesome (synchronous endpoint + polling)
async function verifyEmailAwesome(email) {
  const url = "https://api.emailawesome.com/api/validations/email_validation";
  const headers = {
    "x-api-key": EMAILAWESOME_API_KEY,
    "Accept": "application/json",
    "Content-Type": "application/json"
  };

  const postRes = await axios.post(url, { email }, { headers });
  const id = postRes.data?.id;
  if (!id) return { success: false, info: "No validation ID returned" };

  console.log(`🕓 Queued ${email} for verification (${id})`);

  // Step 2: Poll until complete
  let attempts = 0;
  while (attempts < 20) { // ~1 minute total
    const getRes = await axios.get(url + `?email=${encodeURIComponent(email)}`, { headers });
    const data = getRes.data?.results?.[0];

    if (data && data.status === "COMPLETE") {
      const status = data.email_address_status;
      return {
        success: status === "VALID",
        info: `EmailAwesome: ${status}`
      };
    }

    await new Promise(r => setTimeout(r, 3000)); // Wait 3s
    attempts++;
  }

  return { success: false, info: "EmailAwesome: No COMPLETE result after 60s" };

}



// Main
async function processInputCSV(file) {
  const entries = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .pipe(csvParser())
      .on("data", (r) => {
        if (r.domain && r.fullName) entries.push(r);
      })
      .on("end", resolve)
      .on("error", reject);
  });

  const verified = [];
  let progress = [];
  try {
    if (fs.existsSync(PROGRESS_FILE))
      progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8") || "[]");
  } catch {
    progress = [];
  }

  const done = new Set(progress.map((p) => `${p.domain}||${p.name}`));
  console.log(`Found ${entries.length} entries to process`);

  for (const { domain, fullName } of entries) {
    const key = `${domain}||${fullName}`;
    if (done.has(key)) continue;

    console.log(`\n🔍 Processing: ${fullName} (${domain})`);
    const mxHosts = await getMxRecords(domain);
    let found = false,
      verifiedEmail = null;

    console.log("🌀 Generating email patterns...");
    const candidates = generateEmailCandidates(fullName, domain);

    for (const email of candidates) {
      console.log(`📧 Trying ${email}`);
      const smtp = await verifySMTP(email, mxHosts);
      if (!smtp.success) {
        console.log(`❌ SMTP: ${smtp.info}`);
        continue;
      }

      console.log(`✅ SMTP OK: ${smtp.info}`);
      const ea = await verifyEmailAwesome(email);
      console.log(`🔎 API Check: ${ea.info}`);

      if (ea.success) {
        console.log(`🎯 VALID FOUND: ${email}`);
        verified.push({
          name: fullName,
          domain,
          email,
          method: "SMTP+EmailAwesome",
        });
        found = true;
        verifiedEmail = email;
        break;
      }
    }

    if (!found) console.log(`❌ No valid email found for ${fullName}`);

    progress.push({
      name: fullName,
      domain,
      email: verifiedEmail,
      found,
      ts: Date.now(),
    });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf8");
    done.add(key);
  }

  if (verified.length) {
    const csv = stringify(verified, {
      header: true,
      columns: ["name", "domain", "email", "method"],
    });
    fs.writeFileSync(OUTPUT_FILE, csv, "utf8");
    console.log(`\n📁 Saved verified emails → ${OUTPUT_FILE}`);
  } else console.log("\n⚠️ No valid emails verified.");
}

// Run
processInputCSV(INPUT_FILE).catch((err) =>
  console.error("❌ Error:", err.message)
);
