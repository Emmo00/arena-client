export const arenaAbi = [
  {
    type: "event",
    name: "LobbyOpened",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "playerA", type: "address", indexed: true },
      { name: "stake", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LobbyAccepted",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "playerB", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Settled",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "winner", type: "address", indexed: true },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LobbyRefunded",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "playerA", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "LockedLobbyRefunded",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "playerA", type: "address", indexed: true },
      { name: "playerB", type: "address", indexed: true },
    ],
  },
  {
    type: "function",
    name: "openLobby",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "acceptLobby",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "winner", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refundLobby",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refundLockedLobby",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getTournament",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "playerA", type: "address" },
          { name: "playerB", type: "address" },
          { name: "stakeA", type: "uint256" },
          { name: "stakeB", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "openedAt", type: "uint256" },
          { name: "lockedAt", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "stakeToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "treasury",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "settler",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "stakeAmount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lobbyTimeout",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "matchTimeout",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "nextTournamentId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
