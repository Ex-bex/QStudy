import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Layers3,
  Sparkles,
  Check,
  ShieldCheck,
  GraduationCap,
} from "lucide-react";
import Brand, { BrandMark } from "@/components/brand";
import LearningScene from "@/components/learning-scene";

export default function Home() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <Brand />
        <nav aria-label="Главная навигация">
          <a href="#space">Пространство</a>
          <a href="#how-it-works">Как это работает</a>
          <a href="#assistant">ИИ-помощник</a>
          <Link href="/developers">Разработчики</Link>
        </nav>
        <div className="landing-actions">
          <Link href="/login" className="login-link">
            Войти
          </Link>
          <Link href="/register" className="btn btn-dark">
            Начать учиться
            <ArrowUpRight size={16} />
          </Link>
        </div>
      </header>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <span className="hero-tag">
              <span />
              НОВАЯ ГЛАВА В ВАШЕМ ОБУЧЕНИИ
            </span>
            <h1>
              Меньше хаоса.
              <br />
              Больше{" "}
              <span className="hero-word">
                открытий
                <svg viewBox="0 0 430 17" aria-hidden="true">
                  <path d="M4 10Q180 -3 423 10M34 14Q240 5 395 14" />
                </svg>
              </span>
              <span className="brand-dot">.</span>
            </h1>
            <p>
              Расписание, материалы и умный помощник.
              <br className="desktop-break" /> Всё, что нужно для учёбы — в
              одном спокойном пространстве.
            </p>
            <div className="hero-actions">
              <Link href="/register" className="btn btn-primary">
                Найти свой ритм
                <ArrowUpRight size={19} />
              </Link>
              <a href="#space" className="hero-secondary">
                Заглянуть внутрь
                <ArrowRight size={17} />
              </a>
            </div>
            <div className="hero-note">
              <span className="note-line" />
              <span>ДЛЯ ВАШЕЙ ГРУППЫ. ДЛЯ ВАШЕГО БУДУЩЕГО.</span>
            </div>
          </div>
          <LearningScene />
        </section>
        <div className="feature-strip">
          <span>
            <CalendarDays size={18} />
            Понятное расписание
          </span>
          <i />
          <span>
            <BookOpen size={18} />
            План на каждую неделю
          </span>
          <i />
          <span>
            <Sparkles size={18} />
            ИИ рядом
          </span>
          <i />
          <span>
            <ShieldCheck size={18} />
            Личное остаётся личным
          </span>
        </div>
        <section id="space" className="landing-section">
          <div className="section-top">
            <div>
              <span className="eyebrow">
                ПОРЯДОК В МЫСЛЯХ. ПОРЯДОК В УЧЁБЕ.
              </span>
              <h2>
                Всё на своих местах<span className="brand-dot">.</span>
              </h2>
            </div>
            <p>
              Не переключайтесь между десятками вкладок.
              <br />
              Освободите место для самого важного.
            </p>
          </div>
          <div className="feature-bento">
            <Link href="/dashboard/groups" className="bento-card bento-group">
              <div className="bento-top">
                <span className="feature-icon">
                  <CalendarDays size={22} />
                </span>
                <ArrowUpRight size={21} />
              </div>
              <h3>
                Ваша группа.
                <br />
                Общий ритм.
              </h3>
              <p>
                Занятия, кабинеты и преподаватели.
                <br />
                От расписания — прямо к теме урока.
              </p>
              <div className="group-preview">
                <span className="group-preview-icon">
                  <GraduationCap size={25} />
                </span>
                <div>
                  <strong>ИП-26-3кс</strong>
                  <small>Учебное пространство группы</small>
                </div>
                <ArrowRight size={17} />
              </div>
            </Link>
            <Link href="/dashboard/syllabi" className="bento-card">
              <div className="bento-top">
                <span className="feature-icon">
                  <BookOpen size={22} />
                </span>
                <ArrowUpRight size={21} />
              </div>
              <h3>
                Понятный путь
                <br />
                на весь семестр.
              </h3>
              <p>
                Силабус превращается в учебный план:
                <br />
                недели, темы, задания и критерии.
              </p>
              <div className="syllabus-preview">
                <div>
                  <span />
                  <span />
                  <span />
                </div>
                <span className="syllabus-sheet">
                  <BookOpen size={23} />
                  <small>SYLLABUS</small>
                </span>
                <span className="syllabus-arrow">
                  <ArrowRight size={22} />
                </span>
                <div className="syllabus-checks">
                  <span>
                    <Check size={13} /> Темы
                  </span>
                  <span>
                    <Check size={13} /> Задания
                  </span>
                  <span>
                    <Check size={13} /> Недели
                  </span>
                </div>
              </div>
            </Link>
            <Link href="/dashboard/notes" className="bento-card bento-notes">
              <div className="bento-top">
                <span className="feature-icon">
                  <Layers3 size={22} />
                </span>
                <ArrowUpRight size={21} />
              </div>
              <h3>
                Мысли, которым
                <br />
                есть где остаться.
              </h3>
              <p>
                Заметки, файлы и карточки для повторения. Ваш собственный запас
                знаний.
              </p>
              <div className="note-preview">
                <span>МАЛЕНЬКАЯ МЫСЛЬ</span>
                <p>
                  Понять — лучше,
                  <br />
                  чем просто запомнить.
                </p>
                <i />
              </div>
            </Link>
          </div>
        </section>
        <section id="assistant" className="assistant-section">
          <div className="assistant-copy">
            <span className="eyebrow">ВАШ ПАРТНЁР ПО ЛЮБОПЫТСТВУ</span>
            <h2>
              Сложная тема?
              <br />
              <em>Разберёмся вместе.</em>
            </h2>
            <p>
              Помощник опирается на ваши материалы: объясняет, задаёт вопросы и
              помогает увидеть то, что ускользало.
            </p>
            <Link href="/dashboard/chat" className="btn btn-primary">
              Познакомиться с помощником
              <Sparkles size={16} />
            </Link>
            <small>Чат, тесты, тренировка к экзамену и повторение.</small>
          </div>
          <div className="assistant-demo">
            <div className="assistant-demo-head">
              <span className="scene-icon dark">
                <Sparkles size={17} />
              </span>
              <div>
                <strong>QStudy AI</strong>
                <small>Пример учебного диалога</small>
              </div>
              <span className="demo-dot" />
            </div>
            <p className="demo-question">
              Как лучше подготовиться к новой теме?
            </p>
            <div className="demo-answer">
              <BrandMark className="mini-q" />
              <div>
                <p>Давайте разложим всё по полочкам.</p>
                <div>
                  <b>01</b>
                  <span>Посмотрите тему и цели недели</span>
                </div>
                <div>
                  <b>02</b>
                  <span>Соберите главное в короткой заметке</span>
                </div>
                <div>
                  <b>03</b>
                  <span>Проверьте себя несколькими вопросами</span>
                </div>
              </div>
            </div>
            <div className="demo-input">
              Ваш следующий вопрос…
              <ArrowUpRight size={16} />
            </div>
          </div>
        </section>
        <section id="how-it-works" className="landing-section how-section">
          <span className="eyebrow">ОТКРЫТЬ. ПОНЯТЬ. СДЕЛАТЬ.</span>
          <h2>
            Учёба становится понятнее<span className="brand-dot">.</span>
          </h2>
          <div className="steps-grid">
            {[
              {
                n: "01",
                title: "Найдите свою группу",
                text: "Откройте расписание и выберите занятие. Всё начинается с одного шага.",
              },
              {
                n: "02",
                title: "Посмотрите план",
                text: "Темы по неделям, материалы и модульные работы — в странице дисциплины.",
              },
              {
                n: "03",
                title: "Двигайтесь в своём темпе",
                text: "Сохраняйте заметки, выполняйте задания и закрепляйте знания с помощником.",
              },
            ].map((s) => (
              <div key={s.n}>
                <span>{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="landing-cta">
          <span className="eyebrow">СЛЕДУЮЩАЯ ГЛАВА — ВАША</span>
          <h2>Дайте знаниям пространство.</h2>
          <Link href="/register" className="btn btn-primary">
            Начать с QStudy
            <ArrowUpRight size={18} />
          </Link>
        </section>
      </main>
      <footer className="landing-footer">
        <Brand />
        <span>Учиться. Понимать. Расти.</span>
        <span>QStudy © 2026</span>
        <Link href="/developers">Связь с разработчиками</Link>
        <a href="#">Наверх ↑</a>
      </footer>
    </div>
  );
}
