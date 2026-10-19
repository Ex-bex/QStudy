import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Fingerprint, KeyRound } from "lucide-react";
import { EcosystemLogo } from "@/components/ecosystem-branding";
import { QTestsLogo } from "@/components/qtests-brand";
import { QMessageLogo } from "@/components/qmessage-brand";
import styles from "./identity.module.css";

type IdentityMode = "login" | "register" | "forgot" | "reset";

const copy: Record<
  IdentityMode,
  { label: string; title: string; intro: string }
> = {
  login: {
    label: "РАДЫ ВАС ВИДЕТЬ",
    title: "Войти в Q-ID",
    intro: "Ваш единый аккаунт для учёбы, общения, новых возможностей и игры.",
  },
  register: {
    label: "ЗНАКОМСТВО НАЧИНАЕТСЯ ЗДЕСЬ",
    title: "Создать Q-ID",
    intro:
      "Один аккаунт откроет QStudy, QTests, QCareer, QBall и QMessage. Начнём с вас.",
  },
  forgot: {
    label: "ВОССТАНОВЛЕНИЕ ДОСТУПА",
    title: "Вернуться в аккаунт",
    intro: "Укажите почту вашего Q-ID. Поможем снова получить доступ.",
  },
  reset: {
    label: "НОВЫЙ ПАРОЛЬ",
    title: "Обновить доступ",
    intro: "Придумайте новый пароль для вашего общего аккаунта Q-ID.",
  },
};

const products = [
  {
    name: "QMessage",
    description: "Быть на связи",
    href: "/qmessage",
    logo: "/brand/qmessage-prototype.svg",
  },
  {
    name: "QTests",
    description: "Проверить знания",
    href: "/qtests",
    logo: "/brand/qtests-prototype.svg",
  },
  {
    name: "QStudy",
    description: "Учиться",
    href: "/qstudy",
    logo: "/brand/qforce_logo_main.png",
  },
  {
    name: "QCareer",
    description: "Найти свой путь",
    href: "/qcareer",
    logo: "/brand/qforcelogo_qcareer.png",
  },
  {
    name: "QBall",
    description: "Играть вместе",
    href: "/qball",
    logo: "/branding/qball-logo.png",
  },
] as const;

export default function IdentityShell({
  children,
  mode,
}: {
  children: ReactNode;
  mode: IdentityMode;
}) {
  const content = copy[mode];

  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#identity-form">
        Перейти к форме
      </a>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Q-ID — на главную">
          <EcosystemLogo
            kind="identity"
            className={styles.brandImage}
            alt=""
            width={42}
            height={42}
            unoptimized
          />
          <span>Q-ID</span>
          <span className={styles.brandCaption}>Единый аккаунт</span>
        </Link>
        <Link href="/" className={styles.homeLink}>
          <ArrowLeft size={15} aria-hidden="true" />
          <span>На главную</span>
        </Link>
      </header>

      <main className={styles.main}>
        <section
          className={styles.introduction}
          aria-labelledby="identity-intro"
        >
          <span className={styles.eyebrow}>
            <span className={styles.liveDot} aria-hidden="true" />
            ВАШЕ МЕСТО В ЭКОСИСТЕМЕ
          </span>
          <h2 id="identity-intro" className={styles.headline}>
            Всё начинается
            <br />
            <span>с вас.</span>
          </h2>
          <p className={styles.lead}>
            Учитесь, открывайте новые направления и собирайте друзей на матч.
            Ваш Q-ID объединяет всё это.
          </p>

          <div className={styles.identityVisual} aria-hidden="true">
            <span className={styles.orbit} />
            <span className={`${styles.orbit} ${styles.orbitInner}`} />
            <span className={styles.orbitDot} />
            <div className={styles.identityCard}>
              <div className={styles.identityCardTop}>
                <span className={styles.cardWordmark}>Q-ID</span>
                <span className={styles.cardChip}>
                  <KeyRound size={17} />
                </span>
              </div>
              <div className={styles.cardPerson}>
                <span className={styles.cardAvatar}>
                  <Fingerprint size={27} strokeWidth={1.5} />
                </span>
                <div>
                  <strong>Ваш единый аккаунт</strong>
                  <span>Для того, что важно вам</span>
                </div>
              </div>
              <div className={styles.cardServices}>
                <span>QStudy</span>
                <span>QTests</span>
                <span>QCareer</span>
                <span>QBall</span>
                <span>QMessage</span>
              </div>
            </div>
            <span className={styles.visualCaption}>
              Один вход. Ваши возможности.
            </span>
          </div>

          <nav className={styles.products} aria-label="Проекты экосистемы">
            {products.map((product) => (
              <Link
                className={styles.product}
                href={product.href}
                key={product.name}
              >
                {product.name === "QMessage" ? (
                  <QMessageLogo
                    className={styles.productLogo}
                    width={26}
                    height={26}
                    alt=""
                  />
                ) : product.name === "QTests" ? (
                  <QTestsLogo
                    className={styles.productLogo}
                    width={26}
                    height={26}
                    alt=""
                  />
                ) : (
                  <Image
                    className={styles.productLogo}
                    src={product.logo}
                    alt=""
                    width={26}
                    height={26}
                    unoptimized
                  />
                )}
                <span>
                  <strong>{product.name}</strong>
                  <small>{product.description}</small>
                </span>
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            ))}
          </nav>
        </section>

        <section
          className={styles.formCard}
          aria-labelledby="identity-heading"
          id="identity-form"
          tabIndex={-1}
        >
          <div className={styles.cardHeading}>
            <span className={styles.cardEyebrow}>{content.label}</span>
            <h1 id="identity-heading">{content.title}</h1>
            <p>{content.intro}</p>
          </div>
          {children}
        </section>
      </main>

      <footer className={styles.footer}>
        <span>Q-ID · Один аккаунт для всей экосистемы</span>
        <Link href="/developers">
          Связаться с разработчиками
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </footer>
    </div>
  );
}
