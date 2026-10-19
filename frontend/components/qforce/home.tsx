"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CheckCheck,
  Compass,
  Fingerprint,
  Gamepad2,
  Layers3,
  Mail,
  RefreshCw,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { EcosystemLogo } from "@/components/ecosystem-branding";
import { ProjectLogo } from "@/components/project-logo";
import { QTestsLogo } from "@/components/qtests-brand";
import { QMessageLogo } from "@/components/qmessage-brand";
import { departmentLogoUrl, safeDirectorPhotoUrl } from "@/lib/branding";
import type { DeveloperDepartment } from "@/types/developers";
import styles from "./home.module.css";

function QForceBrand({ footer = false }: { footer?: boolean }) {
  return (
    <Link href="/" className={styles.brand} aria-label="QForce — главная">
      <span className={styles.brandMark}>
        <EcosystemLogo kind="force" alt="" width={40} height={40} />
      </span>
      <span>
        QForce<span className={styles.brandDot}>.</span>
      </span>
      {footer && <small>Создаём вместе.</small>}
    </Link>
  );
}

const projects = [
  {
    name: "QStudy",
    href: "/qstudy",
    category: "ОБРАЗОВАНИЕ",
    color: "study",
    title: "Учёба в своём ритме.",
    description:
      "Группы, расписание, силабусы и модули. Весь учебный маршрут в одном пространстве.",
    action: "Открыть QStudy",
  },
  {
    name: "QTests",
    href: "/qtests",
    category: "ПРАКТИКА",
    color: "tests",
    title: "Знать, а не угадывать.",
    description:
      "Загрузи вопросы из Word, собери случайный тест и разбери ошибки с ИИ.",
    action: "Попробовать QTests",
  },
  {
    name: "QCareer",
    href: "/qcareer",
    category: "ВОЗМОЖНОСТИ",
    color: "career",
    title: "От знаний — к делу.",
    description:
      "Открой свои навыки, узнай о направлениях работы и выбери следующий шаг после учёбы.",
    action: "Найти направление",
  },
  {
    name: "QBall",
    href: "/qball",
    category: "ИГРА",
    color: "ball",
    title: "Соберись своей командой.",
    description:
      "Футбол прямо в браузере. Создай комнату, пригласи друзей и выходи на поле.",
    action: "Перейти к игре",
  },
  {
    name: "QMessage",
    href: "/qmessage",
    category: "ОБЩЕНИЕ",
    color: "message",
    title: "Ближе к своим людям.",
    description:
      "Найди человека по имени и начни разговор. Личные чаты, реакции, фотографии и стикеры с общим Q-ID.",
    action: "Открыть QMessage",
  },
  {
    name: "Q-ID",
    href: "/login",
    category: "ОБЩИЙ АККАУНТ",
    color: "identity",
    title: "Один вход. Твои проекты.",
    description:
      "Общий аккаунт экосистемы: входи в проекты QForce с привычным профилем.",
    action: "Войти через Q-ID",
  },
  {
    name: "QControl",
    href: "/qcontrol",
    category: "АДМИНИСТРАТОРАМ",
    color: "control",
    title: "Всё под контролем.",
    description:
      "Единый центр управления проектами, аккаунтами, учебными данными и командой.",
    action: "Открыть QControl",
  },
] as const;

function ProjectMark({ name }: { name: (typeof projects)[number]["name"] }) {
  const props = { alt: "", width: 48, height: 48 };
  if (name === "QStudy") return <ProjectLogo {...props} />;
  if (name === "QTests") return <QTestsLogo {...props} />;
  if (name === "QMessage") return <QMessageLogo {...props} />;
  if (name === "Q-ID") return <EcosystemLogo kind="identity" {...props} />;
  if (name === "QControl") return <EcosystemLogo kind="control" {...props} />;
  return (
    <Image
      {...props}
      src={
        name === "QBall"
          ? "/branding/qball-logo.png"
          : "/brand/qforcelogo_qcareer.png"
      }
      unoptimized
    />
  );
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] || "")
    .join("")
    .toUpperCase();
}

function DirectorPortrait({ department }: { department: DeveloperDepartment }) {
  const source = safeDirectorPhotoUrl(department);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className={styles.portrait}>
      {source && failed !== source ? (
        <Image
          src={source}
          alt={`Фото: ${department.director || department.name}`}
          fill
          unoptimized
          sizes="(max-width: 620px) 88vw, (max-width: 1000px) 45vw, 330px"
          onError={() => setFailed(source)}
        />
      ) : (
        <span
          className={styles.portraitFallback}
          aria-label={
            department.director
              ? `Руководитель: ${department.director}`
              : "Фото руководителя пока не добавлено"
          }
        >
          <span className={styles.portraitInitials}>
            {initials(department.director) || (
              <UsersRound size={54} strokeWidth={1.2} />
            )}
          </span>
          <span className={styles.photoPending}>Фото скоро появится</span>
        </span>
      )}
      <span className={styles.departmentMark}>
        <Image
          src={departmentLogoUrl(department)}
          alt=""
          width={48}
          height={48}
          unoptimized
        />
      </span>
    </div>
  );
}

function DepartmentContact({
  department,
}: {
  department: DeveloperDepartment;
}) {
  if (/^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,31}$/.test(department.telegram))
    return (
      <a
        href={department.telegram}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.contact}
      >
        Связаться в Telegram <ArrowUpRight size={15} />
      </a>
    );
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(department.email))
    return (
      <a
        href={`mailto:${encodeURIComponent(department.email)}`}
        className={styles.contact}
      >
        <Mail size={15} /> Написать команде
      </a>
    );
  return null;
}

function Team() {
  const [departments, setDepartments] = useState<DeveloperDepartment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => {
    setLoading(true);
    setError(false);
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/developers", {
      signal: controller.signal,
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("directory_unavailable");
        const body = await response.json();
        if (!Array.isArray(body?.departments))
          throw new Error("invalid_directory");
        if (controller.signal.aborted) return;
        setDepartments(
          body.departments
            .filter(
              (department: DeveloperDepartment) =>
                department &&
                Number.isInteger(department.id) &&
                department.id > 0 &&
                typeof department.name === "string",
            )
            .sort(
              (a: DeveloperDepartment, b: DeveloperDepartment) =>
                a.display_order - b.display_order || a.id - b.id,
            ),
        );
        setError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    const refresh = () => reload();
    const storage = (event: StorageEvent) => {
      if (event.key === "qstudy:branding-updated") reload();
    };
    window.addEventListener("qstudy:branding-updated", refresh);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("qstudy:branding-updated", refresh);
      window.removeEventListener("storage", storage);
    };
  }, [reload]);
  if (loading)
    return (
      <div className={styles.teamState} role="status">
        <span className={styles.loadingDot} /> Знакомим с командой QForce…
      </div>
    );
  if (error)
    return (
      <div className={styles.teamState} role="alert">
        <p>Не удалось загрузить команду. Попробуйте ещё раз.</p>
        <button type="button" onClick={reload}>
          <RefreshCw size={16} /> Обновить
        </button>
      </div>
    );
  if (!departments.length)
    return (
      <div className={styles.teamState}>
        <UsersRound size={26} />
        <p>
          Скоро здесь появятся подразделения и люди, которые создают QForce.
        </p>
      </div>
    );
  return (
    <div className={styles.teamGrid}>
      {departments.map((department) => (
        <article className={styles.person} key={department.id}>
          <DirectorPortrait department={department} />
          <div className={styles.personCopy}>
            <span className={styles.personRole}>ДИРЕКТОР ПОДРАЗДЕЛЕНИЯ</span>
            <h3>{department.director || "Руководитель пока не указан"}</h3>
            <p className={styles.departmentName}>{department.name}</p>
            {department.description && (
              <p className={styles.departmentDescription}>
                {department.description}
              </p>
            )}
            <DepartmentContact department={department} />
          </div>
        </article>
      ))}
    </div>
  );
}

export default function QForceHome() {
  return (
    <div className={styles.root}>
      <a href="#main" className={styles.skip}>
        Перейти к содержимому
      </a>
      <header className={styles.header}>
        <QForceBrand />
        <nav className={styles.nav} aria-label="Основная навигация">
          <a href="#projects">Проекты</a>
          <a href="#team">Команда</a>
          <a href="#about">О QForce</a>
        </nav>
        <Link href="/login" className={styles.signIn}>
          <Fingerprint size={17} /> Войти с Q-ID <ArrowUpRight size={16} />
        </Link>
      </header>
      <main id="main">
        <section className={styles.hero} aria-labelledby="hero-heading">
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>
              <span className={styles.statusDot} /> КОМАНДА. ИДЕИ. ЭКОСИСТЕМА.
            </span>
            <h1 id="hero-heading">
              Разные идеи.
              <br />
              Одна <span>QForce.</span>
            </h1>
            <p>
              Создаём проекты, с которыми проще учиться, пробовать новое и
              находить своё. Знакомься с командой — и выбирай, с чего начать.
            </p>
            <div className={styles.heroActions}>
              <a href="#projects" className={styles.primaryButton}>
                Наши проекты <ArrowUpRight size={18} />
              </a>
              <a href="#team" className={styles.textButton}>
                Люди за идеями <ArrowRight size={17} />
              </a>
            </div>
            <div className={styles.heroCaption}>
              <span /> МЫ ДЕЛАЕМ ТО, ЧЕМ ХОЧЕТСЯ ПОЛЬЗОВАТЬСЯ.
            </div>
          </div>
          <div className={styles.heroVisual} aria-hidden="true">
            <span className={styles.visualIndex}>QF / ECOSYSTEM</span>
            <div className={styles.orbitOuter} />
            <div className={styles.orbitInner} />
            <div className={styles.centralMark}>
              <EcosystemLogo kind="force" alt="" width={148} height={148} />
            </div>
            <span className={`${styles.satellite} ${styles.satelliteStudy}`}>
              <BookOpen size={21} />
              <span>
                QStudy<small>учиться</small>
              </span>
            </span>
            <span className={`${styles.satellite} ${styles.satelliteCareer}`}>
              <Compass size={21} />
              <span>
                QCareer<small>расти</small>
              </span>
            </span>
            <span className={`${styles.satellite} ${styles.satelliteBall}`}>
              <Gamepad2 size={21} />
              <span>
                QBall<small>играть</small>
              </span>
            </span>
            <span className={`${styles.satellite} ${styles.satelliteTests}`}>
              <CheckCheck size={21} />
              <span>
                QTests<small>пробовать</small>
              </span>
            </span>
            <span className={styles.visualSpark}>
              <Sparkles size={29} strokeWidth={1.5} />
            </span>
            <span className={styles.visualCaption}>
              Всё начинается
              <br />
              <strong>с любопытства.</strong>
            </span>
            <span className={styles.visualArrow}>
              <ArrowDown size={24} />
            </span>
          </div>
        </section>
        <section
          className={styles.projects}
          id="projects"
          aria-labelledby="projects-heading"
        >
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>01 / ПРОЕКТЫ ЭКОСИСТЕМЫ</span>
              <h2 id="projects-heading">
                Для каждого
                <br />
                следующего шага.
              </h2>
            </div>
            <p>
              От первого учебного модуля до своей команды на поле. Разные
              проекты объединены одним аккаунтом Q-ID.
            </p>
          </div>
          <div className={styles.projectGrid}>
            {projects.map((project) => (
              <Link
                href={project.href}
                key={project.name}
                className={`${styles.projectCard} ${styles[project.color]}`}
                aria-label={`${project.name} — ${project.action}`}
              >
                <div className={styles.projectTop}>
                  <span className={styles.projectMark}>
                    <ProjectMark name={project.name} />
                  </span>
                  <span className={styles.projectCategory}>
                    {project.category}
                  </span>
                  <ArrowUpRight className={styles.projectArrow} size={22} />
                </div>
                <span className={styles.projectName}>{project.name}</span>
                <h3>{project.title}</h3>
                <p>{project.description}</p>
                <span className={styles.projectAction}>
                  {project.action}
                  <ArrowRight size={16} />
                </span>
              </Link>
            ))}
          </div>
        </section>
        <section
          className={styles.about}
          id="about"
          aria-labelledby="about-heading"
        >
          <div className={styles.aboutIntro}>
            <span className={styles.eyebrow}>02 / О НАС</span>
            <h2 id="about-heading">
              За каждым проектом —<br />
              люди и их идеи.
            </h2>
          </div>
          <div className={styles.aboutCopy}>
            <p>
              QForce — команда, которая объединяет разработку, технологии,
              коммуникацию и развитие проектов. Мы строим общую экосистему и
              продумываем, как её части помогают друг другу.
            </p>
            <p>
              QStudy отвечает за обучение. QTests — за практику. QCareer
              помогает увидеть, куда ведут знания. QBall даёт повод собраться
              вместе, а QMessage — оставаться на связи.
            </p>
            <a href="#team" className={styles.textButton}>
              Знакомься с подразделениями <ArrowDown size={17} />
            </a>
          </div>
          <div className={styles.principles}>
            <div>
              <Layers3 size={23} />
              <h3>Связаны между собой</h3>
              <p>Общий вход и знакомый профиль в проектах экосистемы.</p>
            </div>
            <div>
              <UsersRound size={23} />
              <h3>Созданы людьми</h3>
              <p>
                У каждого направления есть команда и человек, который за него
                отвечает.
              </p>
            </div>
            <div>
              <Sparkles size={23} />
              <h3>Открыты новому</h3>
              <p>Учимся, проверяем идеи и развиваем то, чем пользуемся сами.</p>
            </div>
          </div>
        </section>
        <section
          className={styles.team}
          id="team"
          aria-labelledby="team-heading"
        >
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>03 / ЛЮДИ QFORCE</span>
              <h2 id="team-heading">
                Каждый на своём месте.
                <br />
                Все — в одной команде.
              </h2>
            </div>
            <Link href="/developers" className={styles.textButton}>
              Контакты подразделений <ArrowUpRight size={17} />
            </Link>
          </div>
          <Team />
        </section>
        <section className={styles.closing} aria-labelledby="closing-heading">
          <span className={styles.eyebrow}>ТВОЯ ТОЧКА ВХОДА</span>
          <h2 id="closing-heading">
            Начни с того,
            <br />
            что интересно тебе.
          </h2>
          <Link href="/register" className={styles.primaryButton}>
            Создать Q-ID <ArrowUpRight size={19} />
          </Link>
          <a href="#projects" className={styles.closingLink}>
            Или сначала посмотри проекты <ArrowRight size={16} />
          </a>
        </section>
      </main>
      <footer className={styles.footer}>
        <QForceBrand footer />
        <nav aria-label="Навигация внизу страницы">
          <a href="#projects">Проекты</a>
          <a href="#team">Команда</a>
          <Link href="/developers">Связаться с нами</Link>
          <Link href="/login">
            Q-ID <ArrowUpRight size={14} />
          </Link>
        </nav>
        <span className={styles.footerNote}>
          QForce — идеи становятся ближе.
        </span>
      </footer>
    </div>
  );
}
