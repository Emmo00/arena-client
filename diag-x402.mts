import "dotenv/config";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./lib/config";

const CELO_NETWORK = "eip155:42220";
const CELO_USDT = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
const url = `${config.chesspuzzlesApiBase}/puzzles?count=100`;
const account = privateKeyToAccount(config.appWalletPrivateKey as `0x${string}`);

function decodeHeader(r: Response) {
  const h = r.headers.get("payment-required");
  if (!h) return "(no payment-required header on final response)";
  try { const j = JSON.parse(Buffer.from(h, "base64").toString("utf8")); return j.error; }
  catch { return h.slice(0, 200); }
}

console.log("=== FINAL response error check (current pattern) ===");
const client = new x402Client().register(CELO_NETWORK, new ExactEvmScheme(account, { rpcUrl: config.celoRpcUrl }));
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch(url, { headers: { accept: "application/json" } });
console.log("status:", res.status);
console.log("server error (decoded payment-required):", decodeHeader(res));
