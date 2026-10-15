import { FIELD, type GameFrame } from "./engine";

export const FOOTBALL_PALETTE = {
  background: "#2d1a66",
  grid: "#4a2fb3",
  red: "#ef4444",
  blue: "#93c5fd",
  ball: "rgba(255,215,0,.8)",
};

function paintPitch(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = FOOTBALL_PALETTE.background;
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);
  ctx.strokeStyle = FOOTBALL_PALETTE.grid;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= FIELD.width; x += 80) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, FIELD.height);
  }
  for (let y = 0; y <= FIELD.height; y += 80) {
    ctx.moveTo(0, y);
    ctx.lineTo(FIELD.width, y);
  }
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(220,208,255,.48)";
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
  ctx.fillStyle = "rgba(220,208,255,.55)";
  ctx.beginPath();
  ctx.arc(600, 350, 4, 0, Math.PI * 2);
  ctx.fill();
  for (const side of ["red", "blue"] as const) {
    const left = side === "red";
    ctx.fillStyle = left ? "rgba(239,68,68,.09)" : "rgba(147,197,253,.09)";
    ctx.fillRect(
      left ? FIELD.left - FIELD.goalDepth : FIELD.right,
      FIELD.goalTop,
      FIELD.goalDepth,
      FIELD.goalBottom - FIELD.goalTop,
    );
    ctx.strokeStyle = FOOTBALL_PALETTE[side];
    ctx.lineWidth = 3;
    ctx.strokeRect(
      left ? FIELD.left - FIELD.goalDepth : FIELD.right,
      FIELD.goalTop,
      FIELD.goalDepth,
      FIELD.goalBottom - FIELD.goalTop,
    );
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(220,208,255,.22)";
    for (let y = FIELD.goalTop + 14; y < FIELD.goalBottom; y += 14) {
      ctx.beginPath();
      ctx.moveTo(left ? FIELD.left - FIELD.goalDepth : FIELD.right, y);
      ctx.lineTo(left ? FIELD.left : FIELD.right + FIELD.goalDepth, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(220,208,255,.35)";
    ctx.strokeRect(left ? FIELD.left : FIELD.right - 150, 174, 150, 352);
  }
}

/** Cache the static pitch and measure layout only when its size actually changes. */
export class FootballRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly pitch: HTMLCanvasElement;
  private readonly pitchContext: CanvasRenderingContext2D | null;
  private observer: ResizeObserver | null = null;
  private cssWidth = 1;
  private pixelRatio = 0;
  private dirty = true;
  private destroyed = false;
  private fallbackResize = false;
  private readonly resizeListener = () => this.measure();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.pitch = canvas.ownerDocument.createElement("canvas");
    this.pitchContext = this.pitch.getContext("2d", { alpha: false });
    this.measure();
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver((entries) => {
        const entry = entries.find((item) => item.target === this.canvas);
        if (entry) this.measure(entry.contentRect.width);
      });
      this.observer.observe(canvas);
    } else {
      this.fallbackResize = true;
      window.addEventListener("resize", this.resizeListener);
    }
  }

  private measure(width = this.canvas.clientWidth) {
    if (this.destroyed) return;
    const next = Math.max(1, Number.isFinite(width) ? width : 1);
    if (next !== this.cssWidth) {
      this.cssWidth = next;
      this.dirty = true;
    }
  }

  private resize() {
    const actual = window.devicePixelRatio || 1;
    const dpr = Math.min(
      2,
      Math.max(0.5, Number.isFinite(actual) ? actual : 1),
    );
    if (!this.dirty && this.pixelRatio === dpr) return;
    this.pixelRatio = dpr;
    this.dirty = false;
    const width = Math.max(1, Math.round(this.cssWidth * dpr));
    const height = Math.max(
      1,
      Math.round((width * FIELD.height) / FIELD.width),
    );
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.pitch.width = width;
    this.pitch.height = height;
    if (this.pitchContext) {
      this.pitchContext.setTransform(
        width / FIELD.width,
        0,
        0,
        height / FIELD.height,
        0,
        0,
      );
      paintPitch(this.pitchContext);
    }
  }

  draw(frame: GameFrame, ownId: string) {
    if (this.destroyed || !this.ctx || !this.pitchContext) return;
    this.resize();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.pitch, 0, 0);
    ctx.setTransform(
      this.canvas.width / FIELD.width,
      0,
      0,
      this.canvas.height / FIELD.height,
      0,
      0,
    );
    // Flat original discs avoid a full shadow-blur pass for every player each frame.
    ctx.shadowBlur = 0;
    for (const player of frame.players) {
      if (player.id === ownId || player.kicking) {
        ctx.strokeStyle = player.kicking
          ? "rgba(255,255,255,.8)"
          : "rgba(255,215,0,.8)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(player.x, player.y, player.kicking ? 33 : 28, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = FOOTBALL_PALETTE[player.team];
      ctx.beginPath();
      ctx.arc(player.x, player.y, FIELD.playerRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.7)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#201729";
      ctx.font = "700 15px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        (player.name || "?").slice(0, 1).toUpperCase(),
        player.x,
        player.y + 1,
      );
      ctx.fillStyle = player.id === ownId ? "#fff1b2" : "#ddd2f5";
      ctx.font = "12px system-ui";
      ctx.fillText(player.name.slice(0, 19), player.x, player.y + 37);
    }
    const ball = frame.ball;
    ctx.fillStyle = FOOTBALL_PALETTE.ball;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, FIELD.ballRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,235,147,.85)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#8a6314";
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, 3, 0, Math.PI * 2);
    ctx.fill();
    if (frame.kickoff > 0 && !frame.finished) {
      ctx.fillStyle = "rgba(22,11,61,.42)";
      ctx.fillRect(0, 0, FIELD.width, FIELD.height);
      ctx.fillStyle = "#fff1b2";
      ctx.font = "700 58px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(String(Math.ceil(frame.kickoff)), 600, 350);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.fallbackResize)
      window.removeEventListener("resize", this.resizeListener);
    this.pitch.width = 0;
    this.pitch.height = 0;
  }
}
