import { createPublicClient, createWalletClient, http, parseAbiItem } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config, TOKEN_DECIMALS } from "./config";
import { arenaAbi } from "./abi";

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

function makeSettlerWallet() {
  const account = privateKeyToAccount(config.settlerPrivateKey as `0x${string}`);
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
  return makeSettlerWallet();
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
  const hash = await client.writeContract({
    address: config.contractAddress,
    abi: arenaAbi,
    functionName: "settle",
    args: [id, winner],
    account,
  });
  return publicClient().waitForTransactionReceipt({ hash });
}

export async function submitRefundLocked(id: bigint) {
  const { account, client } = settlerWallet();
  const hash = await client.writeContract({
    address: config.contractAddress,
    abi: arenaAbi,
    functionName: "refundLockedLobby",
    args: [id],
    account,
  });
  return publicClient().waitForTransactionReceipt({ hash });
}
