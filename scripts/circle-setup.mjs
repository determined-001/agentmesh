// One-time Circle Developer-Controlled Wallets bootstrap: generates + registers
// the entity secret, then creates a wallet set and buyer/seller/watcher wallets
// on ARC-TESTNET. Reads/writes .env at the repo root; never prints secret
// values to stdout. Run each step yourself — this is not meant to be run by
// an agent, since the entity secret and recovery file must never leave your
// machine.
//
// Usage:
//   pnpm circle:setup entity-secret   # needs CIRCLE_API_KEY already in .env; generates + registers a new secret
//   pnpm circle:setup register        # needs CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET already in .env; registers the existing secret (doesn't generate a new one)
//   pnpm circle:setup wallets         # needs CIRCLE_API_KEY + a REGISTERED CIRCLE_ENTITY_SECRET in .env
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

function readEnv() {
  if (!existsSync(envPath)) {
    throw new Error(".env not found at repo root — run `cp .env.example .env` and set CIRCLE_API_KEY first.");
  }
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function appendEnv(lines) {
  appendFileSync(envPath, `\n${lines.join("\n")}\n`);
}

const cmd = process.argv[2];
const env = readEnv();

if (cmd === "entity-secret") {
  const apiKey = env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error("Set CIRCLE_API_KEY in .env first.");
  if (env.CIRCLE_ENTITY_SECRET) {
    throw new Error(
      "CIRCLE_ENTITY_SECRET is already set in .env — refusing to overwrite. Remove it first if you really want to rotate (this breaks access to wallets created under the old secret).",
    );
  }

  const { registerEntitySecretCiphertext } = await import("@circle-fin/developer-controlled-wallets");
  const entitySecret = randomBytes(32).toString("hex");
  const recoveryDir = join(root, "recovery");
  mkdirSync(recoveryDir, { recursive: true });
  await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath: recoveryDir,
  });
  appendEnv([`CIRCLE_ENTITY_SECRET=${entitySecret}`]);
  console.log(`Entity secret registered and appended to .env as CIRCLE_ENTITY_SECRET.`);
  console.log(`Recovery file saved under ${recoveryDir}/ — move it to secure offline storage now, it's gitignored but don't leave it in the repo.`);
} else if (cmd === "register") {
  const apiKey = env.CIRCLE_API_KEY;
  const entitySecret = env.CIRCLE_ENTITY_SECRET;
  if (!apiKey) throw new Error("Set CIRCLE_API_KEY in .env first.");
  if (!entitySecret) throw new Error("Set CIRCLE_ENTITY_SECRET in .env first (or use `entity-secret` to generate one).");

  const { registerEntitySecretCiphertext } = await import("@circle-fin/developer-controlled-wallets");
  const recoveryDir = join(root, "recovery");
  mkdirSync(recoveryDir, { recursive: true });
  await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath: recoveryDir,
  });
  console.log("Existing CIRCLE_ENTITY_SECRET registered with Circle. .env unchanged (secret was already there).");
  console.log(`Recovery file saved under ${recoveryDir}/ — move it to secure offline storage now, it's gitignored but don't leave it in the repo.`);
} else if (cmd === "wallets") {
  const apiKey = env.CIRCLE_API_KEY;
  const entitySecret = env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error("Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in .env first (run the entity-secret step).");
  }

  const { initiateDeveloperControlledWalletsClient } = await import("@circle-fin/developer-controlled-wallets");
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  const setRes = await client.createWalletSet({ name: "agentmesh-testnet" });
  const walletSetId = setRes.data?.walletSet?.id;
  if (!walletSetId) throw new Error(`Wallet set creation failed: ${JSON.stringify(setRes.data)}`);

  const roles = ["buyer", "seller", "watcher"];
  const out = [`CIRCLE_WALLET_SET_ID=${walletSetId}`];
  for (const role of roles) {
    const res = await client.createWallets({
      walletSetId,
      accountType: "SCA",
      blockchains: ["ARC-TESTNET"],
      count: 1,
      metadata: [{ name: `agentmesh-${role}` }],
    });
    const wallet = res.data?.wallets?.[0];
    if (!wallet) throw new Error(`Wallet creation failed for ${role}: ${JSON.stringify(res.data)}`);
    out.push(`CIRCLE_${role.toUpperCase()}_WALLET_ID=${wallet.id}`);
    out.push(`CIRCLE_${role.toUpperCase()}_WALLET_ADDRESS=${wallet.address}`);
    console.log(`${role}: ${wallet.address}`);
  }
  appendEnv(out);
  console.log("Wallet set + per-role wallet IDs/addresses appended to .env.");
  console.log(
    "DASHBOARD usually mirrors buyer — set CIRCLE_DASHBOARD_WALLET_ID/ADDRESS to the same values as CIRCLE_BUYER_WALLET_ID/ADDRESS above.",
  );
} else {
  console.error("Usage: pnpm circle:setup <entity-secret|register|wallets>");
  process.exit(1);
}
