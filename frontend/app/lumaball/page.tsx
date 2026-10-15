"use client";

import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  CircleDot,
  Gamepad2,
  MoveUpRight,
  ShieldCheck,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";
import { useLumaBall } from "@/components/lumaball/context";

function CourtIllustration() {
  return (
    <div
      className="lb-scene"
      aria-label="Иллюстрация футбольного поля LumaBall"
      role="img"
    >
      <span className="lb-scene-orbit lb-scene-orbit-one" />
      <span className="lb-scene-orbit lb-scene-orbit-two" />
      <span className="lb-scene-caption">
        <span /> ВАШ СЛЕДУЮЩИЙ МАТЧ
      </span>
      <div className="lb-scene-court-shadow" />
      <div className="lb-scene-court">
        <div className="lb-scene-pitch">
          <span className="lb-scene-half" />
          <span className="lb-scene-center" />
          <span className="lb-scene-spot" />
          <span className="lb-scene-goal lb-scene-goal-left" />
          <span className="lb-scene-goal lb-scene-goal-right" />
          <span className="lb-scene-disc lb-scene-disc-one">L</span>
          <span className="lb-scene-disc lb-scene-disc-two">M</span>
          <span className="lb-scene-disc lb-scene-disc-three">Q</span>
          <span className="lb-scene-disc lb-scene-disc-four">B</span>
          <span className="lb-scene-ball">
            <CircleDot size={24} />
          </span>
          <svg
            className="lb-scene-trail"
            viewBox="0 0 400 240"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M140 175q35-90 125-70"
              stroke="#d3c3ff"
              strokeWidth="2"
              strokeDasharray="5 6"
            />
            <path d="m255 98 12 7-12 5" stroke="#d3c3ff" strokeWidth="2" />
          </svg>
        </div>
      </div>
      <div className="lb-scene-note lb-scene-note-top">
        <span>
          <Zap size={15} />
        </span>
        <div>
          <strong>Меньше ожидания</strong>
          <small>Больше игры</small>
        </div>
      </div>
      <div className="lb-scene-note lb-scene-note-bottom">
        <div className="lb-scene-avatars">
          <span>Q</span>
          <span>L</span>
          <span>+</span>
        </div>
        <div>
          <strong>Ваша команда рядом</strong>
          <small>Один аккаунт с QStudy</small>
        </div>
      </div>
      <span className="lb-scene-star">
        <Sparkles size={30} />
      </span>
      <span className="lb-scene-index">01 / IN YOUR ELEMENT</span>
    </div>
  );
}

export default function LumaBallHome() {
  const { config, identity, error, loading } = useLumaBall();
  return (
    <main>
      <section className="lb-hero lb-container" aria-labelledby="lb-hero-title">
        <div className="lb-hero-copy">
          <p className="lb-eyebrow">
            <span className="lb-small-star">✦</span> ДРУГАЯ СТОРОНА ВАШЕГО ДНЯ
          </p>
          <h1 id="lb-hero-title">
            Маленькое поле.
            <br />
            Большие <em>эмоции.</em>
          </h1>
          <p className="lb-hero-description">{config.description}</p>
          <div className="lb-hero-actions">
            <Link href="/lumaball/play" className="lb-button lb-button-primary">
              Время играть <ArrowUpRight size={19} />
            </Link>
            <a href="#how-to-play" className="lb-text-button">
              Как это работает <ArrowDown size={16} />
            </a>
          </div>
          <p className="lb-hero-footnote">
            <span className="lb-live-dot" />{" "}
            {identity
              ? `С возвращением, ${identity.name}`
              : "Без установки. С друзьями. Прямо здесь."}
          </p>
          {!config.enabled && !loading && (
            <p className="lb-inline-notice">
              Площадка временно закрыта. Администратор скоро вернёт игру.
            </p>
          )}
          {error && (
            <p className="lb-inline-notice" role="alert">
              Не удалось загрузить состояние площадки. Проверьте подключение
              перед входом в игру.
            </p>
          )}
        </div>
        <CourtIllustration />
      </section>
      <div className="lb-feature-band">
        <div className="lb-container">
          <span>
            <Gamepad2 size={18} /> 2D-футбол с характером
          </span>
          <i />
          <span>
            <Users size={18} /> Комнаты для друзей
          </span>
          <i />
          <span>
            <Zap size={18} /> Игра в реальном времени
          </span>
          <i />
          <span>
            <ShieldCheck size={18} /> Общий аккаунт QStudy
          </span>
        </div>
      </div>
      <section id="how-to-play" className="lb-section lb-container">
        <div className="lb-section-heading">
          <div>
            <p className="lb-eyebrow">ПРОЩЕ, ЧЕМ ВЫ ДУМАЕТЕ</p>
            <h2>От перерыва до первого гола.</h2>
          </div>
          <p>
            Никаких сложных правил.
            <br />
            Только вы, мяч и немного азарта.
          </p>
        </div>
        <div className="lb-how-grid">
          {[
            {
              number: "01",
              icon: Users,
              title: "Соберите своих",
              text: "Войдите с аккаунтом QStudy или как гость. Выберите открытую комнату или создайте свою.",
            },
            {
              number: "02",
              icon: Gamepad2,
              title: "Найдите свой ритм",
              text: "Двигайтесь, ловите момент и бейте по мячу. Управление доступно с клавиатуры и экрана телефона.",
            },
            {
              number: "03",
              icon: MoveUpRight,
              title: "Играйте на команду",
              text: "Пасуйте, открывайтесь и забивайте. Лучшая комбинация начинается с одного простого движения.",
            },
          ].map((step) => (
            <article className="lb-how-card" key={step.number}>
              <div>
                <span>{step.number}</span>
                <step.icon size={23} />
              </div>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="lb-controls-section">
        <div className="lb-container lb-controls-inner">
          <div>
            <p className="lb-eyebrow">ЧУВСТВУЙТЕ ИГРУ</p>
            <h2>
              Пара клавиш.
              <br />
              <em>Тысяча комбинаций.</em>
            </h2>
            <p>
              Футбол встречает аэрохоккей: простая физика, быстрые решения и
              удовольствие от точного удара.
            </p>
            <Link className="lb-text-button" href="/lumaball/play">
              Выбрать комнату <ArrowRight size={17} />
            </Link>
          </div>
          <div className="lb-keyboard-card">
            <span className="lb-keyboard-label">ВАШ КОРОТКИЙ ПУТЬ К ГОЛУ</span>
            <div className="lb-keyboard-row">
              <div className="lb-wasd">
                <kbd>W</kbd>
                <div>
                  <kbd>A</kbd>
                  <kbd>S</kbd>
                  <kbd>D</kbd>
                </div>
              </div>
              <span>или</span>
              <div className="lb-wasd">
                <kbd>↑</kbd>
                <div>
                  <kbd>←</kbd>
                  <kbd>↓</kbd>
                  <kbd>→</kbd>
                </div>
              </div>
            </div>
            <p>Движение по полю</p>
            <div className="lb-kick-row">
              <kbd>SPACE</kbd>
              <span>Удар по мячу</span>
            </div>
            <small>На телефоне — экранные кнопки движения и удара.</small>
          </div>
        </div>
      </section>
      <section id="rules" className="lb-section lb-container lb-rules-section">
        <div>
          <p className="lb-eyebrow">ХОРОШАЯ ИГРА НАЧИНАЕТСЯ С УВАЖЕНИЯ</p>
          <h2>У каждого есть место на поле.</h2>
          <p className="lb-rules-copy">{config.rules}</p>
        </div>
        <div className="lb-rules-aside">
          <ShieldCheck size={27} />
          <p>
            Личная комната? Задайте пароль при создании и поделитесь им с
            друзьями.
          </p>
          <Link href="/lumaball/play">
            Увидимся на поле <ArrowUpRight size={16} />
          </Link>
        </div>
      </section>
      <section className="lb-final-cta lb-container">
        <span className="lb-eyebrow">УЧЁБА ПОДОЖДЁТ ПЯТЬ МИНУТ</span>
        <h2>Хороший момент, чтобы сыграть.</h2>
        <Link href="/lumaball/play" className="lb-button lb-button-primary">
          Найти свой матч <ArrowUpRight size={18} />
        </Link>
        <span className="lb-cta-spark">✦</span>
      </section>
    </main>
  );
}
