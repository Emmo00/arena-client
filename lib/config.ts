const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  // Celo mainnet
  chainId: 42220,
  celoRpcUrl: process.env.CELO_RPC_URL ?? "http://127.0.0.1:8545",

  // --- arena behaviour (mirrors the contract / protocol) ---
  maxOpenLobbies: num(process.env.MAX_OPEN_LOBBIES, 5),
  sessionDurationSeconds: num(process.env.SESSION_DURATION_SECONDS, 10),
  lobbyTimeoutSeconds: num(process.env.LOBBY_TIMEOUT_SECONDS, 600),
  matchTimeoutSeconds: num(process.env.MATCH_TIMEOUT_SECONDS, 120),
  feeBps: num(process.env.FEE_BPS, 500),

  // --- puzzle cache ---
  puzzlePoolSize: num(process.env.PUZZLE_POOL_SIZE, 40),
  puzzleCacheSize: num(process.env.PUZZLE_CACHE_SIZE, 2000),
  puzzleCacheRefreshHours: num(process.env.PUZZLE_CACHE_REFRESH_HOURS, 24),
  chesspuzzlesApiBase:
    process.env.CHESSPUZZLES_API_BASE ?? "https://api.chesspuzzles.xyz",

  // --- chain addresses / wallets ---
  contractAddress: (process.env.CONTRACT_ADDRESS ?? "") as `0x${string}`,
  treasuryAddress: process.env.TREASURY_ADDRESS ?? "",
  // The settler wallet signs and submits settle().
  settlerPrivateKey: process.env.SETTLER_PRIVATE_KEY ?? "",
  // The app wallet pays chesspuzzles.xyz (x402) for the shared puzzle cache.
  appWalletPrivateKey: process.env.APP_WALLET_PRIVATE_KEY ?? "",

  // --- app infrastructure ---
  appBaseUrl: process.env.APP_BASE_URL ?? "https://arena.chesspuzzles.xyz",
  mongodbUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/arena",
  authJwtSecret: process.env.AUTH_JWT_SECRET ?? "dev-secret-change-me",

  // --- workers ---
  indexerStartBlock: process.env.INDEXER_START_BLOCK
    ? BigInt(process.env.INDEXER_START_BLOCK)
    : null,
  indexerPollMs: num(process.env.INDEXER_POLL_MS, 3000),
  settlerPollMs: num(process.env.SETTLER_POLL_MS, 3000),
  cachePollMs: num(process.env.CACHE_POLL_MS, 30000),
} as const;

export const STAKE_TOKEN_ADDRESS =
  "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as const; // Celo mainnet USDT
export const USDC_ADDRESS = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const; // Celo mainnet USDC
export const TOKEN_DECIMALS = 6;

export const isProd = process.env.NODE_ENV === "production";
