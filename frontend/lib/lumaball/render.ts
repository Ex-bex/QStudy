import { FIELD, type GameFrame } from "./engine";

export function drawFootball(
  canvas: HTMLCanvasElement,
  frame: GameFrame,
  ownId: string,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.round((width * FIELD.height) / FIELD.width);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(width / FIELD.width, 0, 0, height / FIELD.height, 0, 0);
  ctx.clearRect(0, 0, FIELD.width, FIELD.height);
  const background = ctx.createLinearGradient(0, 0, 1200, 700);
  background.addColorStop(0, "#171329");
  background.addColorStop(1, "#100e1d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 1200, 700);
  ctx.fillStyle = "rgba(255,255,255,.013)";
  for (let i = 0; i < 8; i += 2)
    ctx.fillRect(
      FIELD.left + i * 132,
      FIELD.top,
      132,
      FIELD.bottom - FIELD.top,
    );
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(199,180,255,.19)";
  ctx.strokeRect(
    FIELD.left,
    FIELD.top,
    FIELD.right - FIELD.left,
    FIELD.bottom - FIELD.top,
  );
  ctx.beginPath();
  ctx.moveTo(600, FIELD.top);
  ctx.lineTo(600, FIELD.bottom);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(600, 350, 82, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(199,180,255,.35)";
  ctx.beginPath();
  ctx.arc(600, 350, 4, 0, Math.PI * 2);
  ctx.fill();
  for (const side of ["red", "blue"] as const) {
    const left = side === "red";
    ctx.fillStyle = left ? "rgba(248,113,140,.08)" : "rgba(125,169,255,.08)";
    ctx.fillRect(
      left ? FIELD.left - FIELD.goalDepth : FIELD.right,
      FIELD.goalTop,
      FIELD.goalDepth,
      FIELD.goalBottom - FIELD.goalTop,
    );
    ctx.strokeStyle = left ? "#ed809f" : "#8eaeff";
    ctx.lineWidth = 3;
    ctx.strokeRect(
      left ? FIELD.left - FIELD.goalDepth : FIELD.right,
      FIELD.goalTop,
      FIELD.goalDepth,
      FIELD.goalBottom - FIELD.goalTop,
    );
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(207,194,255,.12)";
    for (let y = FIELD.goalTop + 14; y < FIELD.goalBottom; y += 14) {
      ctx.beginPath();
      ctx.moveTo(left ? FIELD.left - FIELD.goalDepth : FIELD.right, y);
      ctx.lineTo(left ? FIELD.left : FIELD.right + FIELD.goalDepth, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(199,180,255,.16)";
    ctx.strokeRect(left ? FIELD.left : FIELD.right - 150, 174, 150, 352);
  }
  for (const p of frame.players) {
    const color = p.team === "red" ? "#f081a5" : "#98b3ff";
    if (p.id === ownId || p.kicking) {
      ctx.strokeStyle = p.kicking
        ? "rgba(255,255,255,.75)"
        : "rgba(195,169,255,.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.kicking ? 33 : 28, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, FIELD.playerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,.7)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#201729";
    ctx.font = "700 15px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((p.name || "?").slice(0, 1).toUpperCase(), p.x, p.y + 1);
    ctx.fillStyle = p.id === ownId ? "#f5edff" : "#bbb3cd";
    ctx.font = "12px system-ui";
    ctx.fillText(p.name.slice(0, 19), p.x, p.y + 37);
  }
  const b = frame.ball;
  ctx.fillStyle = "rgba(0,0,0,.28)";
  ctx.beginPath();
  ctx.ellipse(b.x + 2, b.y + 8, 13, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = "#e5d8ff";
  ctx.shadowBlur = 13;
  ctx.fillStyle = "#f7f2ff";
  ctx.beginPath();
  ctx.arc(b.x, b.y, FIELD.ballRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#695781";
  ctx.beginPath();
  ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
  ctx.fill();
  if (frame.kickoff > 0 && !frame.finished) {
    ctx.fillStyle = "rgba(16,12,28,.42)";
    ctx.fillRect(0, 0, 1200, 700);
    ctx.fillStyle = "#e9dcff";
    ctx.font = "700 58px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(String(Math.ceil(frame.kickoff)), 600, 350);
  }
}
