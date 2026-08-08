// Local fixture puzzles used ONLY when paid x402 fetching is unavailable
// (local dev, e2e harness). Production purchases puzzles from
// https://api.chesspuzzles.xyz via x402. Fixtures never leak out of the server:
// `moves` stays in the DB and is stripped from every HTTP response.
export interface FixturePuzzle {
  puzzleid: string;
  fen: string;
  moves: string[];
  rating: number;
  ratingdeviation: number;
  popularity: number;
  themes: string[];
  openingTags: string[];
  cost: number;
}

// Single-move tactical positions (white to move in all). The e2e harness reads
// solutions from the DB, so the first move is what matters for correctness.
const RAW: Array<[string, string, number, string[]]> = [
  ["7k/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1", "Re8#", 900, ["backRank"]],
  ["6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1", "Re8#", 950, ["backRank"]],
  ["6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", "Ra8#", 950, ["backRank"]],
  ["6k1/5ppp/8/8/8/8/5PPP/Q5K1 w - - 0 1", "Qa8#", 1000, ["backRank"]],
  ["6k1/5ppp/8/8/8/8/5PPP/6KQ w - - 0 1", "Qh8#", 1000, ["backRank"]],
  ["7k/5ppp/8/8/8/8/5PPP/6KQ w - - 0 1", "Qh8#", 1050, ["backRank"]],
  ["r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", "Bxf7+", 1300, ["fork"]],
  ["r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4", "Qxf7#", 900, ["mateIn1"]],
  ["r1bqkbnr/pppp1Qpp/2n5/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 4", "Qxf7#", 800, ["mateIn1"]],
  ["r1bqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQK1NR w KQkq - 0 3", "Qh5+", 1100, ["fork"]],
  ["8/8/8/8/8/8/1k6/1R3K2 w - - 0 1", "Rb3+", 800, ["backRank"]],
  ["8/8/8/8/8/8/1k6/1R4K1 w - - 0 1", "Rb3+", 850, ["backRank"]],
  ["8/8/8/8/2k5/8/3R4/4K3 w - - 0 1", "Rd8", 1000, ["backRank"]],
  ["8/8/8/8/2k5/8/3R4/4K3 w - - 0 1", "Rd8", 1000, ["backRank"]],
  ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "e4", 400, ["opening"]],
  ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "d4", 400, ["opening"]],
  ["6k1/8/8/8/8/8/8/1Q4K1 w - - 0 1", "Qb8+", 600, ["backRank"]],
  ["6k1/8/8/8/8/8/8/2Q3K1 w - - 0 1", "Qc8+", 600, ["backRank"]],
  ["6k1/8/8/8/8/8/8/3Q2K1 w - - 0 1", "Qd8+", 650, ["backRank"]],
  ["6k1/8/8/8/8/8/8/4Q1K1 w - - 0 1", "Qe8+", 650, ["backRank"]],
  ["7k/5ppp/8/8/8/8/5PPP/6R1 w - - 0 1", "Rg8#", 900, ["backRank"]],
  ["7k/5ppp/8/8/8/8/5PPP/5RK1 w - - 0 1", "Rf8#", 950, ["backRank"]],
  ["6k1/5ppp/8/8/8/8/5PPP/5RK1 w - - 0 1", "Rf8#", 950, ["backRank"]],
  ["4k3/8/8/8/8/8/8/3Q2K1 w - - 0 1", "Qe2", 700, ["endgame"]],
  ["4k3/8/8/8/8/8/8/2Q3K1 w - - 0 1", "Qc2", 700, ["endgame"]],
  ["8/8/8/8/8/4k3/8/3Q2K1 w - - 0 1", "Qe2", 750, ["endgame"]],
  ["8/8/8/8/8/4k3/8/2Q3K1 w - - 0 1", "Qe2", 750, ["endgame"]],
  ["8/8/8/8/8/3k4/8/3Q2K1 w - - 0 1", "Qe2", 800, ["endgame"]],
  ["8/8/8/8/8/3k4/8/2Q3K1 w - - 0 1", "Qe2", 800, ["endgame"]],
  ["8/8/8/8/8/2k5/8/3Q2K1 w - - 0 1", "Qc2+", 850, ["endgame"]],
  ["8/8/8/8/8/2k5/8/2Q3K1 w - - 0 1", "Qc2+", 850, ["endgame"]],
  ["8/8/8/8/8/8/1k6/2Q3K1 w - - 0 1", "Qc2", 850, ["endgame"]],
  ["8/8/8/8/8/8/k7/2Q3K1 w - - 0 1", "Qc2", 900, ["endgame"]],
  ["8/8/8/8/8/8/2k5/4Q3 w - - 0 1", "Qe2", 900, ["endgame"]],
  ["8/8/8/8/8/8/1k6/4Q3 w - - 0 1", "Qe2", 900, ["endgame"]],
  ["8/8/8/8/8/8/k7/4Q3 w - - 0 1", "Qe2", 950, ["endgame"]],
  ["8/8/8/8/8/6k1/8/1Q4K1 w - - 0 1", "Qb8", 950, ["endgame"]],
  ["8/8/8/8/8/6k1/8/4Q1K1 w - - 0 1", "Qe8", 950, ["endgame"]],
  ["8/8/8/8/8/5k2/8/1Q4K1 w - - 0 1", "Qb8", 1000, ["endgame"]],
  ["8/8/8/8/8/5k2/8/4Q1K1 w - - 0 1", "Qe8", 1000, ["endgame"]],
  ["8/8/8/8/8/4k3/8/1Q4K1 w - - 0 1", "Qb8", 1000, ["endgame"]],
  ["8/8/8/8/8/4k3/8/4Q1K1 w - - 0 1", "Qe8", 1000, ["endgame"]],
  ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "Rxa8", 1200, ["endgame"]],
  ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "Rxa8", 1200, ["endgame"]],
  ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "Rxa8", 1200, ["endgame"]],
  ["4k3/8/8/8/8/8/8/R5K1 w - - 0 1", "Re1+", 1100, ["endgame"]],
  ["4k3/8/8/8/8/8/8/R5K1 w - - 0 1", "Re1+", 1100, ["endgame"]],
  ["4k3/8/8/8/8/8/8/4R1K1 w - - 0 1", "Re1+", 1100, ["endgame"]],
  ["4k3/8/8/8/8/8/8/4R1K1 w - - 0 1", "Re1+", 1100, ["endgame"]],
  ["8/8/8/8/8/6k1/8/5R1K w - - 0 1", "Rf6", 1050, ["endgame"]],
  ["8/8/8/8/8/6k1/8/5R1K w - - 0 1", "Rf6", 1050, ["endgame"]],
  ["8/8/8/8/8/6k1/8/R5K1 w - - 0 1", "Ra6", 1050, ["endgame"]],
  ["8/8/8/8/8/6k1/8/R5K1 w - - 0 1", "Ra6", 1050, ["endgame"]],
  ["6k1/5ppp/8/8/8/8/5PPP/1Q4K1 w - - 0 1", "Qb8+", 850, ["backRank"]],
  ["6k1/5ppp/8/8/8/8/5PPP/2Q3K1 w - - 0 1", "Qc8+", 850, ["backRank"]],
  ["6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1", "Qd8+", 850, ["backRank"]],
  ["6k1/5ppp/8/8/8/8/5PPP/4Q1K1 w - - 0 1", "Qe8+", 850, ["backRank"]],
  ["8/5k2/8/8/8/8/8/1Q4K1 w - - 0 1", "Qb7", 1000, ["endgame"]],
  ["8/5k2/8/8/8/8/8/4Q1K1 w - - 0 1", "Qe8", 1000, ["endgame"]],
  ["8/8/8/8/8/8/2k5/1Q4K1 w - - 0 1", "Qb8", 950, ["endgame"]],
  ["8/8/8/8/8/8/2k5/2Q3K1 w - - 0 1", "Qc2+", 950, ["endgame"]],
  ["8/8/8/8/8/8/1k6/1Q4K1 w - - 0 1", "Qb8", 950, ["endgame"]],
  ["8/8/8/8/8/8/1k6/2Q3K1 w - - 0 1", "Qc2+", 950, ["endgame"]],
];

export const fixturePuzzles: FixturePuzzle[] = RAW.map(([fen, move, rating, themes], i) => ({
  puzzleid: `fx-${String(i + 1).padStart(4, "0")}`,
  fen,
  moves: [move],
  rating,
  ratingdeviation: 70,
  popularity: 90,
  themes,
  openingTags: [],
  cost: 0,
}));
