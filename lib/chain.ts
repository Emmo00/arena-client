import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbiItem,
  ContractFunctionExecutionError,
  NonceTooHighError,
  NonceTooLowError,
  nonceManager,
  type Hash,
} from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config, TOKEN_DECIMALS } from "./config";
import { arenaAbi } from "./abi";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a tx send when the account nonce collided with an already-broadcast
 * tx (concurrent sends from another process share the settler key). viem
 * resets the nonce manager on error, so the retry refetches the pending nonce.
 * Re-throws the original error once retries are exhausted. */
async function submitWithNonceRetry(send: () => Promise<Hash>, retries = 4): Promise<Hash> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await send();
    } catch (e) {
      const isNonceConflict =
        e instanceof ContractFunctionExecutionError &&
        e.walk(
          (err) => err instanceof NonceTooLowError || err instanceof NonceTooHighError
        ) !== null;
      if (!isNonceConflict || attempt === retries) throw e;
      const backoff = 500 * 2 ** (attempt - 1);
      console.warn(
        `[chain] nonce conflict (attempt ${attempt}/${retries}), retrying in ${backoff}ms`
      );
      await sleep(backoff);
    }
  }
  throw new Error("unreachable");
}

export type PublicClient = ReturnType<typeof publicClient>;

/** Atomic units -> human USDT string, max 6 decimals, no trailing zeros. */
export function toUsdt(atomic: string | number | bigint): string {
  const n = Number(atomic) / 10 ** TOKEN_DECIMALS;
  return n.toFixed(TOKEN_DECIMALS).replace(/0+$/, "").replace(/\.$/, "");
}

/** Live stakeAmount() from the contract, with a dev fallback if unconfigured. */
export async function liveStakeAmount(): Promise<{ atomic: string; usdt: string }> {
  if (!config.contractAddress) {
    const atomic = "1000000"; // dev fallback: 1 USDT
    return { atomic, usdt: toUsdt(atomic) };
  }
  try {
    const atomic = (
      await publicClient().readContract({
        address: config.contractAddress,
        abi: arenaAbi,
        functionName: "stakeAmount",
      })
    ).toString();
    return { atomic, usdt: toUsdt(atomic) };
  } catch {
    const atomic = "1000000";
    return { atomic, usdt: toUsdt(atomic) };
  }
}

export function publicClient() {
  return createPublicClient({
    chain: celo,
    transport: http(config.celoRpcUrl),
  });
}

export type SettlerWallet = ReturnType<typeof makeSettlerWallet>;

// Cached singleton: concurrent sends share one account + nonce manager so
// within a process viem hands out strictly increasing, conflict-free nonces.
let wallet: SettlerWallet | null = null;

function makeSettlerWallet() {
  const account = privateKeyToAccount(config.settlerPrivateKey as `0x${string}`, {
    nonceManager,
  });
  return {
    account,
    client: createWalletClient({
      account,
      chain: celo,
      transport: http(config.celoRpcUrl),
    }),
  };
}

export function settlerWallet(): SettlerWallet {
  if (!wallet) wallet = makeSettlerWallet();
  return wallet;
}

export const arenaEvents = {
  lobbyOpened: parseAbiItem(
    "event LobbyOpened(uint256 indexed id, address indexed playerA, uint256 stake)"
  ),
  lobbyAccepted: parseAbiItem(
    "event LobbyAccepted(uint256 indexed id, address indexed playerB)"
  ),
  settled: parseAbiItem(
    "event Settled(uint256 indexed id, address indexed winner, uint256 fee)"
  ),
  lobbyRefunded: parseAbiItem(
    "event LobbyRefunded(uint256 indexed id, address indexed playerA)"
  ),
  lockedLobbyRefunded: parseAbiItem(
    "event LockedLobbyRefunded(uint256 indexed id, address indexed playerA, address indexed playerB)"
  ),
};

export const allArenaEvents = Object.values(arenaEvents);

/** Chunked eth_getLogs — Celo RPC rejects ranges above ~50k blocks. */
export async function getLogsChunked(
  fromBlock: bigint,
  toBlock: bigint,
  events: ReturnType<typeof parseAbiItem>[]
) {
  const client = publicClient();
  const CHUNK = 45_000n;
  const logs: Awaited<ReturnType<typeof client.getLogs>> = [];
  let from = fromBlock;
  while (from <= toBlock) {
    const to = from + CHUNK > toBlock ? toBlock : from + CHUNK;
    const chunk = await client.getLogs({
      address: config.contractAddress,
      events,
      fromBlock: from,
      toBlock: to,
    });
    logs.push(...chunk);
    if (to === toBlock) break;
    from = to + 1n;
  }
  return logs;
}

export type ArenaLog = Awaited<ReturnType<typeof getLogsChunked>>[number];

export async function getTournament(id: bigint) {
  return publicClient().readContract({
    address: config.contractAddress,
    abi: arenaAbi,
    functionName: "getTournament",
    args: [id],
  });
}

export async function submitSettle(id: bigint, winner: `0x${string}`) {
  const { account, client } = settlerWallet();
  const hash = await submitWithNonceRetry(() =>
    client.writeContract({
      address: config.contractAddress,
      abi: arenaAbi,
      functionName: "settle",
      args: [id, winner],
      account,
    })
  );
  return publicClient().waitForTransactionReceipt({ hash });
}

export async function submitRefundLocked(id: bigint) {
  const { account, client } = settlerWallet();
  const hash = await submitWithNonceRetry(() =>
    client.writeContract({
      address: config.contractAddress,
      abi: arenaAbi,
      functionName: "refundLockedLobby",
      args: [id],
      account,
    })
  );
  return publicClient().waitForTransactionReceipt({ hash });
}
