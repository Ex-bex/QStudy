import { FIELD, type GameFrame } from "./engine";

export const FOOTBALL_PALETTE = {
  background: "#10171d",
  turf: "#173f35",
  stripe: "rgba(214,244,222,.035)",
  line: "rgba(232,245,236,.64)",
  red: "#ef4444",
  blue: "#93c5fd",
  ball: "rgba(255,215,0,.8)",
};

function paintPitch(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = FOOTBALL_PALETTE.background;
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);
  const width = FIELD.right - FIELD.left;
  const height = FIELD.bottom - FIELD.top;
  ctx.fillStyle = "#1b2a2a";
  ctx.fillRect(FIELD.left - 12, FIELD.top - 12, width + 24, height + 24);
  ctx.strokeStyle = "rgba(180,202,197,.13)";
  ctx.lineWidth = 1;
  ctx.strokeRect(FIELD.left - 12, FIELD.top - 12, width + 24, height + 24);
  ctx.fillStyle = FOOTBALL_PALETTE.turf;
  ctx.fillRect(FIELD.left, FIELD.top, width, height);
  const light = ctx.createLinearGradient(
    FIELD.left,
    FIELD.top,
    FIELD.right,
    FIELD.bottom,
  );
  light.addColorStop(0, "rgba(125,177,140,.07)");
  light.addColorStop(0.5, "rgba(125,177,140,0)");
  light.addColorStop(1, "rgba(0,9,14,.19)");
  ctx.fillStyle = light;
  ctx.fillRect(FIELD.left, FIELD.top, width, height);
  ctx.fillStyle = FOOTBALL_PALETTE.stripe;
  const stripeWidth = width / 12;
  for (let index = 0; index < 12; index += 2)
    ctx.fillRect(
      FIELD.left + index * stripeWidth,
      FIELD.top,
      stripeWidth,
      height,
    );

  // Goal mouths and boundaries share the simulation's exact coordinates.
  for (const side of ["red", "blue"] as const) {
    const left = side === "red";
    const x = left ? FIELD.left - FIELD.goalDepth : FIELD.right;
    ctx.fillStyle = "#152329";
    ctx.fillRect(
      x,
      FIELD.goalTop,
      FIELD.goalDepth,
      FIELD.goalBottom - FIELD.goalTop,
    );
    ctx.strokeStyle = "rgba(222,234,232,.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let offset = 8; offset < FIELD.goalDepth; offset += 8) {
      ctx.moveTo(x + offset, FIELD.goalTop);
      ctx.lineTo(x + offset, FIELD.goalBottom);
    }
    for (let y = FIELD.goalTop + 12; y < FIELD.goalBottom; y += 12) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + FIELD.goalDepth, y);
    }
    ctx.stroke();
    ctx.strokeStyle = left ? "#bf7180" : "#83a9c2";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left ? FIELD.left : FIELD.right, FIELD.goalTop);
    ctx.lineTo(left ? x : x + FIELD.goalDepth, FIELD.goalTop);
    ctx.lineTo(left ? x : x + FIELD.goalDepth, FIELD.goalBottom);
    ctx.lineTo(left ? FIELD.left : FIELD.right, FIELD.goalBottom);
    ctx.stroke();
  }

  ctx.strokeStyle = FOOTBALL_PALETTE.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(FIELD.left, FIELD.top);
  ctx.lineTo(FIELD.right, FIELD.top);
  ctx.moveTo(FIELD.left, FIELD.bottom);
  ctx.lineTo(FIELD.right, FIELD.bottom);
  for (const x of [FIELD.left, FIELD.right]) {
    ctx.moveTo(x, FIELD.top);
    ctx.lineTo(x, FIELD.goalTop);
    ctx.moveTo(x, FIELD.goalBottom);
    ctx.lineTo(x, FIELD.bottom);
  }
  ctx.moveTo(FIELD.width / 2, FIELD.top);
  ctx.lineTo(FIELD.width / 2, FIELD.bottom);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(600, 350, 82, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#d8e7dd";
  ctx.beginPath();
  ctx.arc(600, 350, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(232,245,236,.46)";
  for (const left of [true, false]) {
    const goalLine = left ? FIELD.left : FIELD.right;
    for (const [depth, top, bottom] of [
      [150, 174, 526],
      [55, 220, 480],
    ]) {
      const inside = goalLine + (left ? depth : -depth);
      ctx.beginPath();
      ctx.moveTo(goalLine, top);
      ctx.lineTo(inside, top);
      ctx.lineTo(inside, bottom);
      ctx.lineTo(goalLine, bottom);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(
      left ? FIELD.left + 112 : FIELD.right - 112,
      350,
      2.5,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  for (const [x, y, start] of [
    [FIELD.left, FIELD.top, 0],
    [FIELD.right, FIELD.top, Math.PI / 2],
    [FIELD.right, FIELD.bottom, Math.PI],
    [FIELD.left, FIELD.bottom, Math.PI * 1.5],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, 14, start, start + Math.PI / 2);
    ctx.stroke();
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
