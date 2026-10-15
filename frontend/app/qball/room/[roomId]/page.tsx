import GameRoom from "@/components/lumaball/game-room";

export default async function QBallRoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return <GameRoom roomId={roomId} />;
}
