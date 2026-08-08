"use client";

import { useState } from "react";

type EthProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthProvider;
  }
}

const CELO_CHAIN_ID_HEX = "0xa4f1"; // 42220

export default function ConnectWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setError(null);
    if (!window.ethereum) {
      setError("No injected wallet found (MetaMask / MiniPay).");
      return;
    }
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const chain = (await window.ethereum.request({
        method: "eth_chainId",
      })) as string;
      setAddress(accounts[0] ?? null);
      setChainId(chain);
    } catch {
      setError("Connection rejected.");
    }
  }

  const onCelo = chainId === CELO_CHAIN_ID_HEX;

  return (
    <div className="flex flex-col items-start gap-2">
      <button onClick={connect} className="neo-btn">
        {address ? `CONNECTED ▸ ${short(address)}` : "CONNECT WALLET"}
      </button>
      {address && (
        <p className="font-mono text-xs">
          {onCelo ? (
            <span className="text-green-700">✓ Celo mainnet (42220)</span>
          ) : (
            <span className="text-loud">⚠ switch to Celo mainnet (chain id 42220)</span>
          )}
        </p>
      )}
      {error && <p className="font-mono text-xs text-loud">{error}</p>}
    </div>
  );
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
