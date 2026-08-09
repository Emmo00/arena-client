import { config } from "@/lib/config";
import { dbCollections } from "@/lib/db";
import { handleApiError, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tournaments = await dbCollections().tournaments();
    const open = await tournaments
      .find({ status: "Open", serviced: { $ne: false } })
      .sort({ _id: -1 })
      .limit(50)
      .toArray();
    return json({
      lobbies: open.map((t) => ({
        id: t._id,
        stake: t.stakeA,
        openedAt: t.openedAt,
        expiresAt: t.openedAt + config.lobbyTimeoutSeconds,
      })),
      count: open.length,
      capacity: config.maxOpenLobbies,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
