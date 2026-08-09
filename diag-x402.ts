import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./lib/config";

console.log("chainId:", config.chainId, "rpc:", config.celoRpcUrl, "base:", config.chesspuzzlesApiBase);
console.log("appWallet configured:", !!config.appWalletPrivateKey);

const account = privateKeyToAccount(config.appWalletPrivateKey as `0x${string}`);
const client = new x402Client().register(
  "eip155:42220",
  new ExactEvmScheme(account, { rpcUrl: config.celoRpcUrl })
);
const payFetch = wrapFetchWithPayment(fetch, client);
const url = `${config.chesspuzzlesApiBase}/puzzles?count=100`;

try {
  const res = await payFetch(url, { headers: { accept: "application/json" } });
  console.log("res.ok:", res.ok, "status:", res.status);
  if (!res.ok) console.log("body:", (await res.text()).slice(0, 500));
  else {
    const data = await res.json();
    console.log("puzzles array length:", Array.isArray(data.puzzles) ? data.puzzles.length : "N/A");
  }
} catch (e: unknown) {
  const err = e as {
    constructor?: { name?: string };
    message?: string;
    cause?: { message?: string };
    stack?: string;
  };
  console.error("X402 FAILED:", err?.constructor?.name);
  console.error("message:", err?.message);
  if (err?.cause) console.error("cause:", err.cause.message ?? err.cause);
  console.error("stack:", err?.stack?.split("\n").slice(0, 10).join("\n"));
}
