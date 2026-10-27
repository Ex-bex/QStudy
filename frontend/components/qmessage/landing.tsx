"use client";

import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCheck,
  Fingerprint,
  Heart,
  MessageCircle,
  Send,
  ShieldCheck,
  Smile,
  Sparkles,
} from "lucide-react";
import { QMessageLogo } from "@/components/qmessage-brand";
import { useQMessage } from "./context";
import styles from "./qmessage.module.css";
import { AppInstallButton } from "@/components/app-install";

export default function QMessageLanding() {
  const { config } = useQMessage();
  return (
    <div className={styles.landing}>
      <a className={styles.skip} href="#message-main">
        Перейти к содержимому
      </a>
      <header className={styles.landingHeader}>
        <Link className={styles.brand} href="/qmessage">
          <QMessageLogo alt="" width={43} height={43} />
          <span>
            {config?.title || "QMessage"}
            <small>есть что сказать</small>
          </span>
        </Link>
        <nav aria-label="Навигация QMessage">
          <AppInstallButton compact />
          <Link href="/">
            <ArrowLeft size={15} /> QForce
          </Link>
          <Link href="/qmessage/chats" className={styles.primary}>
            Открыть сообщения <ArrowUpRight size={16} />
          </Link>
        </nav>
      </header>
      <main id="message-main">
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>
              <span /> НА СВЯЗИ. В СВОЁМ КРУГУ.
            </p>
            <h1>
              Хорошие идеи
              <br />
              начинаются
              <br />
              <em>с «привет».</em>
            </h1>
            <p>
              {config?.description ||
                "Обсуди пару, договорись об игре или просто спроси, как дела. Личные сообщения для людей твоей экосистемы."}
            </p>
            <Link href="/qmessage/chats" className={styles.primary}>
              Начать разговор <ArrowUpRight size={19} />
            </Link>
            <small>
              <Fingerprint size={14} /> Твой привычный аккаунт Q-ID
            </small>
          </div>
          <div
            className={styles.landingPreview}
            aria-label="Пример интерфейса переписки, не настоящий разговор"
          >
            <div className={styles.previewTitle}>
              <span className={styles.exampleAvatar}>Q</span>
              <span>
                <strong>Ваша команда</strong>
                <small>Пример переписки</small>
              </span>
              <span className={styles.previewDots}>•••</span>
            </div>
            <div className={styles.previewDate}>Сегодня</div>
            <div className={styles.previewReceived}>
              Привет! Разобрались с новым модулем?<small>12:40</small>
            </div>
            <div className={styles.previewSent}>
              Да! Давай после пары обсудим вместе.
              <small>
                12:41 <CheckCheck size={14} />
              </small>
            </div>
            <div className={styles.previewReceived}>
              Отлично, до встречи 👋
              <span className={styles.previewReaction}>❤️ 1</span>
              <small>12:41</small>
            </div>
            <div className={styles.previewSticker} aria-hidden="true">
              ✦<Smile size={52} strokeWidth={1.4} />✦
            </div>
            <div className={styles.previewComposer}>
              <Smile size={20} />
              <span>Написать сообщение…</span>
              <span>
                <Send size={17} />
              </span>
            </div>
            <span className={styles.previewNote}>
              <Sparkles size={15} /> От учёбы до хороших новостей.
            </span>
          </div>
        </section>
        <section
          className={styles.landingFeatures}
          aria-labelledby="message-features"
        >
          <div>
            <p className={styles.eyebrow}>ПРОСТО БЫТЬ НА СВЯЗИ</p>
            <h2 id="message-features">
              Разговор —<br />в удобном темпе.
            </h2>
          </div>
          <article>
            <MessageCircle size={24} />
            <h3>Свои люди рядом</h3>
            <p>
              Найди человека по имени и начни личный разговор. Общий аккаунт,
              без отдельной регистрации.
            </p>
          </article>
          <article>
            <Heart size={24} />
            <h3>Больше, чем текст</h3>
            <p>
              Ответы на сообщения, реакции и стикеры, когда хочется сказать
              немного больше.
            </p>
          </article>
          <article>
            <ShieldCheck size={24} />
            <h3>Твоё пространство</h3>
            <p>
              История сохраняется. Доступ к разговору — у его участников;
              блокировка и жалобы доступны в чате.
            </p>
          </article>
        </section>
        <section className={styles.landingClosing}>
          <QMessageLogo alt="" width={52} height={52} />
          <h2>Останемся на связи?</h2>
          <Link href="/qmessage/chats" className={styles.primary}>
            Перейти в QMessage <ArrowRight size={18} />
          </Link>
        </section>
      </main>
      <footer className={styles.landingFooter}>
        <span>
          QMessage <b>·</b> Часть экосистемы QForce
        </span>
        <nav aria-label="Проекты экосистемы">
          <Link href="/qstudy">QStudy</Link>
          <Link href="/qtests">QTests</Link>
          <Link href="/qball">QBall</Link>
          <Link href="/developers">Команда</Link>
        </nav>
      </footer>
    </div>
  );
}
