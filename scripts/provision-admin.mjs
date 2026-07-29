#!/usr/bin/env node

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/;
const USERNAME_EMAIL_SUFFIX = "@users.jorgardemail.local";

function fail(message) {
  process.stderr.write(`[provision-admin] ${message}\n`);
  process.exit(1);
}

async function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 16_384) fail("input is too large");
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail("expected a JSON object on stdin");
  }
}

const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !serviceKey) fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

const input = await readStdin();
const username = typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
const password = typeof input.password === "string" ? input.password : "";
const displayName =
  typeof input.displayName === "string" && input.displayName.trim()
    ? input.displayName.trim().slice(0, 80)
    : username;

if (!USERNAME_RE.test(username))
  fail("username must be 3-24 characters using letters, digits, _ or -");
if (password.length < 12 || password.length > 128) fail("password must be 12-128 characters");

const headers = {
  apikey: serviceKey,
  authorization: `Bearer ${serviceKey}`,
  "content-type": "application/json",
};

const roleCheck = await fetch(
  `${baseUrl}/rest/v1/user_roles?role=eq.admin&select=user_id&limit=1`,
  { headers },
);
if (!roleCheck.ok) fail(`could not inspect administrator state (HTTP ${roleCheck.status})`);
const roles = await roleCheck.json();
if (Array.isArray(roles) && roles.length > 0) {
  process.stdout.write("administrator already provisioned\n");
  process.exit(0);
}

const response = await fetch(`${baseUrl}/auth/v1/admin/users`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    email: `${username}${USERNAME_EMAIL_SUFFIX}`,
    password,
    email_confirm: true,
    user_metadata: { username, display_name: displayName },
    app_metadata: { jorgarde_admin: true },
  }),
});

if (!response.ok) {
  let detail = "authentication service rejected the request";
  try {
    const payload = await response.json();
    if (typeof payload?.message === "string") detail = payload.message;
    else if (typeof payload?.msg === "string") detail = payload.msg;
  } catch {
    // Keep the generic detail; never echo the submitted body.
  }
  fail(`${detail} (HTTP ${response.status})`);
}

const created = await response.json();
if (!created?.id) fail("authentication service returned an invalid user response");
process.stdout.write(`created administrator @${username}\n`);
