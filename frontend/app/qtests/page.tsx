"use client";

import Link from "next/link";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  FileUp,
  Layers3,
  Shuffle,
  Sparkles,
} from "lucide-react";
import styles from "@/components/qtests/qtests.module.css";
import { useQTestsConfig } from "@/components/qtests/shell";

export default function QTestsHome() {
  const config = useQTestsConfig();
  return (
    <main id="qtests-main">
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span /> ВОПРОСЫ ВАШИ. ПОРЯДОК НОВЫЙ.
          </p>
          <h1>
            Ваши вопросы.
            <br />
            Новая попытка.
            <br />
            <em>Больше знаний.</em>
          </h1>
          <p>
            {config?.description ||
              "Превратите документ с вопросами в личную тренировку. Случайные вопросы, перемешанные варианты и понятный разбор после каждого ответа."}
          </p>
          <div className={styles.heroActions}>
            <Link href="/qtests/library" className={styles.primary}>
              Открыть QTests <ArrowUpRight size={19} />
            </Link>
            <a href="#how-it-works" className={styles.textLink}>
              Как это работает <ArrowDown size={16} />
            </a>
          </div>
          <small>
            Один аккаунт Q-ID · Ваши документы и результаты сохраняются
          </small>
        </div>
        <div
          className={styles.preview}
          aria-label="Пример: из банка на 300 вопросов получается случайная тренировка на 40"
        >
          <div className={styles.previewTop}>
            <span className={styles.dot} /> ВАША СЛЕДУЮЩАЯ ТРЕНИРОВКА{" "}
            <span>01 / 40</span>
          </div>
          <div className={styles.sourceSlip}>
            <FileUp size={24} />
            <div>
              <strong>Экзаменационные вопросы.docx</strong>
              <span>300 вопросов в исходном банке</span>
            </div>
            <Check size={19} />
          </div>
          <div className={styles.shuffleLine}>
            <span />
            <Shuffle size={19} />
            <span />
          </div>
          <div className={styles.previewQuestion}>
            <span className={styles.eyebrow}>ПРИМЕР ВОПРОСА</span>
            <h2>
              Чему вы хотите научиться
              <br />
              во время подготовки?
            </h2>
            <div>
              <span>A</span> Запоминать порядок вариантов
            </div>
            <div className={styles.previewCorrect}>
              <span>B</span> Понимать правильный ответ <Check size={18} />
            </div>
            <div>
              <span>C</span> Узнавать номер вопроса
            </div>
          </div>
          <p className={styles.previewNote}>
            <Sparkles size={16} /> Перемешиваем варианты. Сохраняем смысл.
          </p>
        </div>
      </section>
      <section className={styles.how} id="how-it-works">
        <div className={styles.sectionTitle}>
          <p className={styles.eyebrow}>ИЗ ДОКУМЕНТА — В ПРАКТИКУ</p>
          <h2>
            Меньше подготовки
            <br />к подготовке.
          </h2>
          <p>
            Все вопросы остаются в банке. Для каждого нового прохождения QTests
            собирает отдельную случайную подборку.
          </p>
        </div>
        <div className={styles.featureGrid}>
          {[
            {
              icon: FileUp,
              title: "Загрузите Word",
              text: "Выберите DOCX и укажите, как отмечены правильные ответы. Если в исходнике все ответы — A, QTests учтёт это перед перемешиванием.",
            },
            {
              icon: Layers3,
              title: "Проверьте весь банк",
              text: "Посмотрите число извлечённых вопросов, предупреждения и ответы. Уточните формулировки, исправьте варианты или добавьте свои вопросы.",
            },
            {
              icon: Shuffle,
              title: "Пройдите свои 40",
              text: "Вопросы выбираются без повторов, а варианты меняются местами. После ответа виден результат, после ошибки — правильный вариант и разбор.",
            },
          ].map(({ icon: Icon, title, text }, i) => (
            <article key={title}>
              <div>
                <span>0{i + 1}</span>
                <Icon size={25} />
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>
      <section className={styles.closing}>
        <div>
          <p className={styles.eyebrow}>ВАШ БАНК. ВАШ ТЕМП.</p>
          <h2>
            300 вопросов в файле.
            <br />
            <em>40 шагов к уверенности.</em>
          </h2>
          <p>
            Продолжайте незаконченные тренировки и возвращайтесь к ошибкам. Если
            в банке меньше 40 вопросов, в подборку войдут все доступные.
          </p>
        </div>
        <Link href="/qtests/library" className={styles.primary}>
          Загрузить первый документ <ArrowUpRight size={19} />
        </Link>
      </section>
    </main>
  );
}
