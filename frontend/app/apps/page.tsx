import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Download, Smartphone } from "lucide-react";
import { AppInstallButton } from "@/components/app-install";
import { PWA_APPS } from "@/lib/pwa";
import styles from "./apps.module.css";

export const metadata: Metadata = {
  title: { absolute: "Приложения QForce — установка" },
  description:
    "Установите QStudy, QMessage, QTests и другие проекты QForce как отдельные веб-приложения на телефон или компьютер.",
};

export default function AppsPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/">
          <ArrowLeft size={17} /> QForce
        </Link>
        <span>ПРИЛОЖЕНИЯ ЭКОСИСТЕМЫ</span>
      </header>
      <main className={styles.main}>
        <div className={styles.intro}>
          <Smartphone size={34} aria-hidden="true" />
          <h1>
            Ваши проекты.
            <br />
            Прямо на экране телефона.
          </h1>
          <p>
            У каждого приложения своё имя, иконка и точка входа. Выберите
            проект, откройте его и нажмите «Установить».
          </p>
        </div>
        <div className={styles.grid}>
          {PWA_APPS.map((app) => (
            <a
              key={app.id}
              className={styles.card}
              href={
                app.id === "qforce"
                  ? "/"
                  : app.id === "qid"
                    ? "/login"
                    : `/${app.id}`
              }
            >
              <span
                className={styles.mark}
                style={{ background: app.backgroundColor, color: app.color }}
              >
                <Download size={24} />
              </span>
              <div>
                <h2>{app.name}</h2>
                <p>{app.description}</p>
                {app.id === "qcontrol" && <small>Для администраторов</small>}
              </div>
              <ArrowUpRight size={18} aria-hidden="true" />
            </a>
          ))}
        </div>
        <section className={styles.instructions} aria-labelledby="apps-how">
          <h2 id="apps-how">Как установить</h2>
          <div className={styles.steps}>
            <article>
              <h3>Android</h3>
              <p>
                Откройте проект в Chrome или Samsung Internet. Нажмите
                «Установить» на сайте или в меню браузера и подтвердите
                установку.
              </p>
            </article>
            <article>
              <h3>iPhone и iPad</h3>
              <p>
                Откройте проект в Safari. Нажмите «Поделиться» → «На экран
                „Домой“» → «Добавить». Если есть пункт «Открывать как
                веб-приложение», включите его.
              </p>
            </article>
            <article>
              <h3>Компьютер</h3>
              <p>
                Откройте проект в Chrome или Edge. Нажмите «Установить» на сайте
                или значок установки в адресной строке.
              </p>
            </article>
          </div>
          <div className={styles.note}>
            <strong>Установка требует HTTPS.</strong>
            <p>
              Адрес вида http://IP:8080 позволяет открыть сайт и создать ярлык,
              но не подходит для полноценной установки. Исключение — localhost
              на самом устройстве. Владельцу хоста нужно подключить HTTPS с
              доверенным сертификатом.
            </p>
          </div>
          <p className={styles.detail}>
            Если вы пришли из Telegram или другого приложения, откройте ссылку
            во внешнем браузере. Возможности установки зависят от браузера и
            устройства. Уже созданный ярлык можно удалить и установить
            приложение заново.
          </p>
          <p className={styles.detail}>
            Установка не переносит сервер на телефон. Для работы с расписанием,
            тестами, перепиской и матчами нужен интернет и работающий хост. При
            потере сети приложение покажет экран подключения; личные страницы и
            сообщения не сохраняются в общем офлайн-кэше.
          </p>
          <AppInstallButton />
        </section>
      </main>
    </div>
  );
}
