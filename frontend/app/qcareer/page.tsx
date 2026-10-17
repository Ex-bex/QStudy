"use client";

import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpenCheck,
  Compass,
  Fingerprint,
  Flag,
  Layers3,
  Route,
  ScanLine,
  Sparkles,
} from "lucide-react";
import { useCareer } from "@/components/career/context";
import styles from "@/components/career/career.module.css";

function Journey() {
  return (
    <div
      className={styles.journey}
      role="img"
      aria-label="От изученной темы к навыку и профессиональному направлению"
    >
      <span className={styles.journeyCaption}>ПРОДОЛЖЕНИЕ ВАШЕЙ ИСТОРИИ</span>
      <svg
        viewBox="0 0 500 460"
        fill="none"
        aria-hidden="true"
        className={styles.journeyPath}
      >
        <path
          d="M40 360C205 390 118 150 280 190S340 65 455 65"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="5 8"
        />
        <circle cx="455" cy="65" r="7" fill="currentColor" />
      </svg>
      <div className={styles.orbit}>
        <Compass size={110} strokeWidth={0.8} />
      </div>
      <div className={`${styles.journeyCard} ${styles.cardLearn}`}>
        <span>
          <BookOpenCheck size={20} />
        </span>
        <div>
          <small>НАЧАЛО</small>
          <strong>То, что вы изучили</strong>
          <p>Предметы, модули, практика</p>
        </div>
        <b>01</b>
      </div>
      <div className={`${styles.journeyCard} ${styles.cardSkill}`}>
        <span>
          <Fingerprint size={23} />
        </span>
        <div>
          <small>ВАШ БАГАЖ</small>
          <strong>То, что вы умеете</strong>
          <p>Навыки с учебной историей</p>
        </div>
        <b>02</b>
      </div>
      <div className={`${styles.journeyCard} ${styles.cardFuture}`}>
        <span>
          <Flag size={22} />
        </span>
        <div>
          <small>ГОРИЗОНТ</small>
          <strong>Куда двигаться дальше</strong>
          <p>Направление и следующий шаг</p>
        </div>
        <ArrowUpRight size={26} />
      </div>
      <span className={styles.journeyNote}>
        Путь начинается не с резюме.
        <br />
        Он начинается с любопытства.
      </span>
    </div>
  );
}

export default function CareerHome() {
  const { config, user, loading } = useCareer();
  const href = user
    ? "/qcareer/workspace"
    : "/login?next=%2Fqcareer%2Fworkspace";
  return (
    <main id="career-main">
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span />
            ОТКРОЙТЕ СЛЕДУЮЩУЮ ГЛАВУ
          </p>
          <h1>
            Знания — ваши.
            <br />
            <em>Куда с ними?</em>
          </h1>
          <p className={styles.heroDescription}>
            {config?.description ||
              "Разберитесь, что уже умеете, какие направления вам близки и чему учиться дальше. Ваша учёба в QStudy — основа личной траектории."}
          </p>
          <div className={styles.heroActions}>
            <Link href={href} className={styles.primary}>
              Найти своё направление <ArrowUpRight size={19} />
            </Link>
            <a href="#career-how" className={styles.textButton}>
              Как это устроено <ArrowDown size={16} />
            </a>
          </div>
          <p className={styles.footnote}>
            Один аккаунт с QStudy · Ваш прогресс уже рядом
          </p>
          {!loading && config && !config.enabled && (
            <p className={styles.notice}>
              QCareer временно закрыт. Администратор скоро откроет раздел.
            </p>
          )}
        </div>
        <Journey />
      </section>
      <div className={styles.ribbon}>
        <span>Учебная история</span>
        <ArrowRight size={17} />
        <span>Подтверждённые навыки</span>
        <ArrowRight size={17} />
        <span>Осознанный следующий шаг</span>
      </div>
      <section className={styles.section} id="career-how">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>БЕЗ ГАДАНИЯ О БУДУЩЕМ</p>
            <h2>
              У вашей учёбы
              <br />
              появится перспектива.
            </h2>
          </div>
          <p>
            Каждая пройденная тема — часть большой картины. QCareer помогает её
            увидеть.
          </p>
        </div>
        <div className={styles.features}>
          {[
            {
              icon: ScanLine,
              title: "Соберите картину навыков",
              text: "Силабусы задают учебные цели, а результаты тестов и проверенных работ показывают прогресс. У каждого навыка — понятный источник.",
            },
            {
              icon: Compass,
              title: "Примерьте направления",
              text: "Посмотрите, в каких профессиях полезны ваши знания. Сравните требования с тем, что уже освоили, и выберите цель.",
            },
            {
              icon: Route,
              title: "Сделайте конкретный шаг",
              text: "Вернитесь к нужному модулю, потренируйтесь или пройдите тест. Рекомендации ведут к материалам вашего обучения.",
            },
          ].map(({ icon: Icon, title, text }, i) => (
            <article key={title}>
              <div className={styles.featureNumber}>
                <span>0{i + 1}</span>
                <Icon size={26} />
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>
      <section className={styles.principles}>
        <div>
          <p className={styles.eyebrow}>ВЫ БОЛЬШЕ, ЧЕМ ОЦЕНКА</p>
          <h2>
            Не ярлык.
            <br />
            <em>Отправная точка.</em>
          </h2>
          <p>
            Карьерное направление можно менять. Добавляйте интересы, пробуйте
            новое и возвращайтесь к своей траектории по мере обучения.
          </p>
          <Link href={href} className={styles.textButton}>
            Посмотреть свою траекторию <ArrowRight size={18} />
          </Link>
        </div>
        <div className={styles.principleList}>
          <article>
            <Layers3 size={23} />
            <div>
              <h3>Опираться на реальные знания</h3>
              <p>
                Результаты обучения и ваши интересы помогают выбрать следующий
                шаг.
              </p>
            </div>
          </article>
          <article>
            <Sparkles size={23} />
            <div>
              <h3>Понимать рекомендации</h3>
              <p>
                Видно, какого навыка не хватает и почему предложена конкретная
                тема.
              </p>
            </div>
          </article>
          <article>
            <Flag size={23} />
            <div>
              <h3>Исследовать, а не обещать</h3>
              <p>
                Справочник направлений помогает с выбором. Он не является
                гарантией трудоустройства или профессиональной аттестацией.
              </p>
            </div>
          </article>
        </div>
      </section>
      <section className={styles.finalCta}>
        <span className={styles.eyebrow}>
          СЛЕДУЮЩИЙ ШАГ НЕ ОБЯЗАТЕЛЬНО БОЛЬШОЙ
        </span>
        <h2>Главное — чтобы он был вашим.</h2>
        <Link href={href} className={styles.primary}>
          Начать с себя <ArrowUpRight size={19} />
        </Link>
      </section>
    </main>
  );
}
