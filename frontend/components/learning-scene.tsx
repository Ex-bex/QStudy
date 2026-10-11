"use client";

import { useRef, useState } from "react";
import { ProjectLogo } from "@/components/project-logo";
import {
  ArrowUpRight,
  BookOpen,
  Check,
  Sparkles,
  Pause,
  Play,
} from "lucide-react";

export default function LearningScene({
  compact = false,
}: {
  compact?: boolean;
}) {
  const scene = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  return (
    <div
      className={`learning-scene ${compact ? "scene-compact" : ""} ${paused ? "scene-paused" : ""}`}
      ref={scene}
      onPointerMove={(e) => {
        if (paused || e.pointerType !== "mouse") return;
        const box = e.currentTarget.getBoundingClientRect();
        scene.current?.style.setProperty(
          "--mx",
          `${(e.clientX - box.left - box.width / 2) / 36}deg`,
        );
        scene.current?.style.setProperty(
          "--my",
          `${-(e.clientY - box.top - box.height / 2) / 45}deg`,
        );
      }}
      onPointerLeave={() => {
        scene.current?.style.setProperty("--mx", "0deg");
        scene.current?.style.setProperty("--my", "0deg");
      }}
    >
      <div className="scene-grid" aria-hidden="true" />
      <div className="scene-orbit orbit-one" aria-hidden="true" />
      <div className="scene-orbit orbit-two" aria-hidden="true" />
      <div className="scene-world" aria-hidden="true">
        <div className="scene-platform" />
        <div className="book-3d book-bottom">
          <div className="book-cover">
            <span>
              THE ART OF
              <br />
              LEARNING
            </span>
            <span className="book-number">01</span>
          </div>
          <div className="book-pages" />
          <div className="book-spine" />
        </div>
        <div className="book-3d book-top">
          <div className="book-cover">
            <span className="book-q">
              <ProjectLogo
                className="book-brand-image"
                alt=""
                width={78}
                height={78}
                sizes="78px"
                unoptimized
              />
              <span>QSTUDY</span>
            </span>
            <span className="book-caption">
              A LITTLE CURIOUS.
              <br />
              ALWAYS GROWING.
            </span>
            <div className="book-line" />
          </div>
          <div className="book-pages" />
          <div className="book-spine" />
        </div>
        <div className="scene-sphere" />
        <div className="scene-pencil">
          <span />
        </div>
        <div className="scene-ring" />
      </div>
      <div className="scene-float float-plan">
        <span className="scene-icon">
          <BookOpen size={17} />
        </span>
        <div>
          <strong>Всё по плану</strong>
          <small>От темы к результату</small>
        </div>
        <span className="float-check">
          <Check size={12} />
        </span>
      </div>
      <div className="scene-float float-ai">
        <span className="scene-icon dark">
          <Sparkles size={18} />
        </span>
        <div>
          <strong>Чуть больше ясности</strong>
          <small>Ваш ИИ-помощник</small>
        </div>
        <ArrowUpRight size={16} />
      </div>
      <span className="scene-label">МАЛЕНЬКИЕ ШАГИ. БОЛЬШИЕ ОТКРЫТИЯ.</span>
      {!compact && (
        <button
          className="scene-motion"
          onClick={() => setPaused((v) => !v)}
          aria-label={paused ? "Включить анимацию" : "Остановить анимацию"}
          title={paused ? "Включить анимацию" : "Остановить анимацию"}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
      )}
    </div>
  );
}
