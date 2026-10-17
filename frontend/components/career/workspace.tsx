"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  BookOpenCheck,
  Check,
  Compass,
  ExternalLink,
  Fingerprint,
  Flag,
  LayoutGrid,
  Loader2,
  MapPin,
  RefreshCw,
  Route,
  Settings2,
  ShieldCheck,
  Target,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  careerDate,
  careerExternalHref,
  careerInterests,
  careerLearningHref,
  careerPercent,
  careerTab,
  type CareerTab,
} from "@/lib/career";
import type {
  CareerDirection,
  CareerOpportunity,
  CareerOpportunityKind,
  CareerProfile,
  CareerRecommendations,
  CareerSkill,
  CareerWorkspace as WorkspaceData,
} from "@/types/career";
import { useCareer } from "./context";
import styles from "./career.module.css";

const TABS = [
  { id: "overview", title: "Моя траектория", icon: LayoutGrid },
  { id: "skills", title: "Навыки", icon: Fingerprint },
  { id: "directions", title: "Направления", icon: Compass },
  { id: "plan", title: "Следующие шаги", icon: Route },
  { id: "opportunities", title: "Возможности", icon: Flag },
  { id: "profile", title: "Мои интересы", icon: Settings2 },
] as const;

const KIND_LABELS: Record<CareerOpportunityKind, string> = {
  job: "Работа",
  internship: "Стажировка",
  study: "Образование",
  course: "Курс",
};

function message(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Не удалось выполнить действие. Попробуйте ещё раз.";
}

function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.status}>
      <Compass size={31} strokeWidth={1.4} />
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

function Level({ level = 0 }: { level?: number }) {
  const safeLevel = Number.isFinite(level)
    ? Math.max(0, Math.min(5, Math.trunc(level)))
    : 0;
  return (
    <span className={styles.levelDots} aria-label={`Уровень ${safeLevel} из 5`}>
      {[1, 2, 3, 4, 5].map((index) => (
        <i key={index} data-filled={safeLevel >= index} />
      ))}
      <small>{safeLevel}/5</small>
    </span>
  );
}

function Coverage({
  value,
  short = false,
}: {
  value: number | null | undefined;
  short?: boolean;
}) {
  const percent = careerPercent(value);
  return (
    <>
      <div className={styles.progress} aria-hidden="true">
        <span style={{ width: `${percent ?? 0}%` }} />
      </div>
      <div className={styles.progressLabel}>
        <span>
          {short ? "Совпадение навыков" : "Освоено требований направления"}
        </span>
        <strong>{percent === null ? "Пока нет данных" : `${percent}%`}</strong>
      </div>
    </>
  );
}

function Overview({
  data,
  navigate,
}: {
  data: WorkspaceData;
  navigate: (tab: CareerTab) => void;
}) {
  const demonstrated = data.skills
    .filter((skill) => (skill.level ?? 0) > 0)
    .sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
  return (
    <>
      <div className={styles.statGrid}>
        <article className={styles.stat}>
          <span>ПОДТВЕРЖДЁННЫЕ НАВЫКИ</span>
          <strong>{data.summary.demonstrated_skills}</strong>
          <small>из результатов обучения</small>
        </article>
        <article className={styles.stat}>
          <span>УЧЕБНЫЕ ПОДТВЕРЖДЕНИЯ</span>
          <strong>{data.summary.evidence_count}</strong>
          <small>тесты и проверенные работы</small>
        </article>
        <article className={styles.stat}>
          <span>ЗАВЕРШЁННЫЕ ТЕСТЫ</span>
          <strong>{data.activity.finished_tests}</strong>
          <small>активность в QStudy</small>
        </article>
      </div>
      <div className={styles.workspaceGrid}>
        <article className={`${styles.panel} ${styles.goal}`}>
          <p className={styles.eyebrow}>
            <Target size={15} />
            МОЁ НАПРАВЛЕНИЕ
          </p>
          <h2 className={styles.goalTitle}>
            {data.summary.target_direction_title ||
              "Будущее начинается с интереса"}
          </h2>
          <p className={styles.muted}>
            {data.summary.target_direction_title
              ? "Сравнивайте свою учебную базу с требованиями направления и постепенно закрывайте пробелы."
              : "Выберите направление, чтобы увидеть подходящие навыки и получить конкретный план обучения."}
          </p>
          {data.summary.target_direction_title && (
            <Coverage value={data.summary.readiness} />
          )}
          <button
            className={styles.secondary}
            onClick={() => navigate("directions")}
          >
            {data.summary.target_direction_title
              ? "Посмотреть направления"
              : "Выбрать направление"}
            <ArrowUpRight size={16} />
          </button>
        </article>
        <article className={styles.panel}>
          <div className={styles.panelHeading}>
            <h2>Ваши сильные стороны</h2>
            <Fingerprint size={23} />
          </div>
          {demonstrated.length ? (
            <div className={styles.skillList}>
              {demonstrated.slice(0, 4).map((skill) => (
                <div className={styles.skillRow} key={skill.id}>
                  <div>
                    <strong>{skill.name}</strong>
                    <small>{skill.evidence?.length || 0} подтверждений</small>
                  </div>
                  <Level level={skill.level} />
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.inlineEmpty}>
              Здесь появятся навыки после прохождения связанных тестов и
              проверки работ преподавателем. Самостоятельная отметка недели не
              начисляет уровень.
            </p>
          )}
          <button
            className={styles.loadMore}
            onClick={() => navigate("skills")}
          >
            Открыть все навыки <ArrowRight size={13} />
          </button>
        </article>
        <article className={`${styles.panel} ${styles.fullWidth}`}>
          <div className={styles.panelHeading}>
            <div>
              <h2>Учебная история превращается в маршрут</h2>
              <p>
                {data.recommendations.reason ||
                  "Следующий шаг зависит от выбранного направления и доступных учебных материалов."}
              </p>
            </div>
            <Route size={25} />
          </div>
          {data.recommendations.steps[0] ? (
            <>
              <h3>{data.recommendations.steps[0].title}</h3>
              <p className={styles.muted} style={{ marginTop: 8 }}>
                {data.recommendations.steps[0].reason}
              </p>
              <button
                className={styles.secondary}
                onClick={() => navigate("plan")}
              >
                Открыть план <ArrowRight size={15} />
              </button>
            </>
          ) : (
            <div className={styles.buttonRow}>
              <button
                className={styles.secondary}
                onClick={() =>
                  navigate(
                    data.profile.target_direction_id ? "skills" : "directions",
                  )
                }
              >
                {data.profile.target_direction_id
                  ? "Посмотреть учебную базу"
                  : "Начать с выбора направления"}
                <ArrowRight size={15} />
              </button>
              <Link href="/dashboard/groups" className={styles.textButton}>
                Перейти к своим предметам <BookOpenCheck size={15} />
              </Link>
            </div>
          )}
          <div className={styles.activity}>
            <div>
              <strong>{data.activity.completed_weeks}</strong>
              <span>отмечено учебных недель</span>
            </div>
            <div>
              <strong>{data.activity.graded_works}</strong>
              <span>работ с оценкой</span>
            </div>
            <div>
              <strong>{data.profile.interests.length}</strong>
              <span>личных интересов</span>
            </div>
          </div>
        </article>
      </div>
    </>
  );
}

function Skills({ skills }: { skills: CareerSkill[] }) {
  const [query, setQuery] = useState("");
  const [onlyConfirmed, setOnlyConfirmed] = useState(false);
  const visible = skills.filter(
    (skill) =>
      (!onlyConfirmed || (skill.level ?? 0) > 0) &&
      `${skill.name} ${skill.category}`
        .toLocaleLowerCase("ru")
        .includes(query.toLocaleLowerCase("ru")),
  );
  return (
    <>
      <div className={styles.sectionIntro}>
        <div>
          <h2>Что вы уже умеете</h2>
          <p>
            Уровень складывается из результатов связанных учебных тестов и
            проверенных работ. Разверните навык, чтобы увидеть источник.
          </p>
        </div>
        <Fingerprint size={28} />
      </div>
      <div className={styles.filters}>
        <label className={styles.fieldLabel}>
          Поиск навыка
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={styles.input}
            placeholder="Например, программирование"
            type="search"
          />
        </label>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={onlyConfirmed}
            onChange={(event) => setOnlyConfirmed(event.target.checked)}
          />
          Только подтверждённые
        </label>
      </div>
      {visible.length ? (
        <div className={styles.cardGrid}>
          {visible.map((skill) => (
            <article className={styles.skillCard} key={skill.id}>
              <div className={styles.cardTop}>
                <span className={styles.badge}>
                  {skill.category || "Навык"}
                </span>
                {(skill.level ?? 0) > 0 && (
                  <ShieldCheck
                    size={18}
                    color="#9e602e"
                    aria-label="Есть учебное подтверждение"
                  />
                )}
              </div>
              <h2>{skill.name}</h2>
              <p>
                {skill.description ||
                  "Требования и учебные связи этого навыка настраивает администратор."}
              </p>
              <Level level={skill.level} />
              {skill.evidence?.length ? (
                <details className={styles.evidence}>
                  <summary>Подтверждения · {skill.evidence.length}</summary>
                  <ul>
                    {skill.evidence.map((item, index) => {
                      const href = careerLearningHref(item.href);
                      return (
                        <li key={`${item.kind}-${item.source_id}-${index}`}>
                          <div>
                            {href ? (
                              <Link href={href}>
                                <BookOpenCheck size={14} />
                                <span>{item.title}</span>
                                <ArrowUpRight size={12} />
                              </Link>
                            ) : (
                              <span className={styles.muted}>{item.title}</span>
                            )}
                            <small>
                              {item.kind === "test"
                                ? "Тест"
                                : "Проверенная работа"}{" "}
                              · {Math.round(item.score)}% · уровень {item.level}
                              /5{item.module ? ` · ${item.module}` : ""}
                              {careerDate(item.verified_at)
                                ? ` · ${careerDate(item.verified_at)}`
                                : ""}
                            </small>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              ) : (
                <p className={styles.inlineEmpty}>
                  Подтверждений пока нет. Пройдите связанный учебный тест или
                  сдайте работу на проверку.
                </p>
              )}
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title={
            skills.length ? "Навыки не найдены" : "Каталог навыков пока пуст"
          }
        >
          {skills.length
            ? "Измените запрос или снимите фильтр подтверждённых навыков."
            : "Администратор может добавить навыки и связать их с предметами, модулями и проверкой знаний."}
        </Empty>
      )}
    </>
  );
}

function Directions({
  data,
  choose,
  busy,
  navigate,
}: {
  data: WorkspaceData;
  choose: (id: number | null) => Promise<void>;
  busy: boolean;
  navigate: (tab: CareerTab) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const visible = data.directions.filter((item) =>
    `${item.title} ${item.category} ${item.description}`
      .toLocaleLowerCase("ru")
      .includes(query.toLocaleLowerCase("ru")),
  );
  return (
    <>
      <div className={styles.sectionIntro}>
        <div>
          <h2>Куда можно двигаться</h2>
          <p>
            Изучите профессиональные и образовательные направления. Процент
            показывает освоение настроенных требований, а не вероятность
            трудоустройства.
          </p>
        </div>
        <Compass size={28} />
      </div>
      <div className={styles.filters}>
        <label className={styles.fieldLabel}>
          Найти направление
          <input
            className={styles.input}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Профессия, область или интерес"
          />
        </label>
      </div>
      {visible.length ? (
        <div className={styles.cardGrid}>
          {visible.map((direction: CareerDirection) => {
            const selected = data.profile.target_direction_id === direction.id;
            const open = expanded === direction.id;
            return (
              <article
                className={`${styles.directionCard} ${selected ? styles.directionSelected : ""}`}
                key={direction.id}
              >
                <div className={styles.cardTop}>
                  <span className={styles.badge}>
                    {direction.category || "Направление"}
                  </span>
                  {selected && (
                    <span className={styles.badge}>
                      <Check size={11} />
                      Моя цель
                    </span>
                  )}
                </div>
                <h2>{direction.title}</h2>
                <p>{direction.description}</p>
                <Coverage value={direction.readiness} short />
                <div className={styles.directionActions}>
                  <button
                    className={selected ? styles.secondary : styles.primary}
                    disabled={busy}
                    onClick={() =>
                      selected ? navigate("plan") : void choose(direction.id)
                    }
                  >
                    {selected ? "Посмотреть план" : "Выбрать целью"}
                    <ArrowUpRight size={13} />
                  </button>
                  <button
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : direction.id)}
                  >
                    {open ? "Скрыть подробности" : "Навыки и перспективы"}
                  </button>
                </div>
                {open && (
                  <div className={styles.details}>
                    <h3>Навыки направления</h3>
                    {direction.requirements.length ? (
                      direction.requirements.map((requirement) => (
                        <div
                          className={styles.requirement}
                          key={requirement.skill_id}
                          data-met={
                            (requirement.current_level ?? 0) >=
                            requirement.level
                          }
                        >
                          <span>
                            {requirement.skill_name ||
                              `Навык #${requirement.skill_id}`}
                          </span>
                          <span>
                            {requirement.current_level ?? 0} /{" "}
                            {requirement.level}
                            {(requirement.current_level ?? 0) >=
                            requirement.level
                              ? " · освоено"
                              : " · есть что изучить"}
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className={styles.muted}>
                        Требования ещё не настроены администратором.
                      </p>
                    )}
                    {direction.career_paths.length > 0 && (
                      <>
                        <h3>Профессиональные роли</h3>
                        <ul>
                          {direction.career_paths.map((path) => (
                            <li key={path}>{path}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {direction.study_paths.length > 0 && (
                      <>
                        <h3>Варианты продолжения обучения</h3>
                        <ul>
                          {direction.study_paths.map((path) => (
                            <li key={path}>{path}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {selected && (
                      <button
                        className={styles.plainButton}
                        disabled={busy}
                        onClick={() => void choose(null)}
                      >
                        Снять текущую цель
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <Empty
          title={
            data.directions.length
              ? "Нет совпадений"
              : "Направления скоро появятся"
          }
        >
          {data.directions.length
            ? "Попробуйте другое название или область интересов."
            : "Администратор может добавить направления, их требования и варианты дальнейшего обучения."}
        </Empty>
      )}
    </>
  );
}

function Plan({
  recommendations,
  target,
  hasGroup,
  navigate,
}: {
  recommendations: CareerRecommendations;
  target: number | null;
  hasGroup: boolean;
  navigate: (tab: CareerTab) => void;
}) {
  return (
    <>
      <div className={styles.sectionIntro}>
        <div>
          <h2>Следующий шаг — понятный</h2>
          <p>
            {recommendations.reason ||
              "План опирается на требования направления, текущие навыки и доступные учебные связи."}
          </p>
        </div>
        <Route size={28} />
      </div>
      {recommendations.direction_title && (
        <div className={styles.readOnly}>
          {target ? "Направление" : "Пример маршрута для направления"}:{" "}
          <strong>{recommendations.direction_title}</strong>.
          {!target && (
            <>
              {" "}
              Вы ещё не выбрали цель.{" "}
              <button
                className={styles.plainButton}
                onClick={() => navigate("directions")}
              >
                Сравнить направления <ArrowRight size={12} />
              </button>
            </>
          )}
        </div>
      )}
      {recommendations.steps.length ? (
        <div className={styles.steps}>
          {recommendations.steps.map((step, index) => {
            const href = careerLearningHref(step.href);
            const testHref = careerLearningHref(step.test_href);
            return (
              <article className={styles.step} key={step.id}>
                <span className={styles.stepNumber}>{index + 1}</span>
                <div>
                  <h2>{step.title}</h2>
                  <p>{step.description}</p>
                  <div className={styles.stepMeta}>
                    {(step.gains?.length
                      ? step.gains
                      : [
                          {
                            skill_id: step.skill_id,
                            skill_name: step.skill_name,
                            from_level: step.from_level,
                            to_level: step.to_level,
                          },
                        ]
                    ).map((gain) => (
                      <span className={styles.badge} key={gain.skill_id}>
                        {gain.skill_name} · {gain.from_level} → {gain.to_level}
                        /5
                      </span>
                    ))}
                    <span className={styles.badge}>{step.course_title}</span>
                    {step.module && (
                      <span className={styles.badge}>{step.module}</span>
                    )}
                    {step.week_number !== null && (
                      <span className={styles.badge}>
                        Неделя {step.week_number}
                      </span>
                    )}
                  </div>
                  <p className={styles.stepReason}>{step.reason}</p>
                  {step.prerequisites.length > 0 && (
                    <p style={{ marginTop: 10 }}>
                      Перед началом:{" "}
                      {step.prerequisites
                        .map(
                          (item) =>
                            `${item.skill_name || `навык #${item.skill_id}`} — ${item.level}/5`,
                        )
                        .join(", ")}
                    </p>
                  )}
                  <div className={styles.stepLinks}>
                    {href && (
                      <Link href={href} className={styles.primary}>
                        Открыть учебный материал <ArrowUpRight size={14} />
                      </Link>
                    )}
                    {testHref && (
                      <Link href={testHref} className={styles.secondary}>
                        Проверить знания <BookOpenCheck size={14} />
                      </Link>
                    )}
                    {!href && !testHref && (
                      <span className={styles.muted}>
                        Источник недоступен. Обратитесь к администратору для
                        уточнения учебной связи.
                      </span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty
          title={
            !hasGroup
              ? "Сначала нужна учебная группа"
              : target
                ? "Сейчас нет доступных шагов"
                : "Сначала выберите направление"
          }
          action={
            !hasGroup ? (
              <Link href="/developers" className={styles.primary}>
                Связаться с администрацией <ArrowUpRight size={15} />
              </Link>
            ) : (
              <button
                className={styles.primary}
                onClick={() => navigate(target ? "skills" : "directions")}
              >
                {target ? "Посмотреть навыки" : "Найти направление"}
                <ArrowRight size={15} />
              </button>
            )
          }
        >
          {!hasGroup
            ? "Администратор должен назначить вам группу в QStudy. После этого план сможет использовать её опубликованные предметы, силабусы и модули. Самостоятельно менять группу нельзя."
            : target
              ? "Требования уже освоены либо для оставшихся навыков пока нет подходящих учебных материалов и связей. Посмотрите навыки или обратитесь к администратору."
              : "QCareer сравнит выбранную цель с вашей учебной базой и предложит последовательность до трёх шагов."}
        </Empty>
      )}
      {recommendations.remaining_gaps.length > 0 && (
        <div className={styles.nextGap}>
          <h3>Что ещё стоит развивать</h3>
          <p>
            {recommendations.remaining_gaps
              .map(
                (gap) =>
                  `${gap.skill_name}: ${gap.current_level} из ${gap.required_level}`,
              )
              .join(" · ")}
          </p>
        </div>
      )}
      {recommendations.assumptions.length > 0 && (
        <ul className={styles.assumptions}>
          {recommendations.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      )}
      <p className={styles.disclaimer}>
        Предлагаемый прирост — ориентир. Навык подтвердится после успешного
        прохождения связанного теста или проверки работы. Открытие материала
        само по себе уровень не повышает.
      </p>
    </>
  );
}

function Opportunities({ directions }: { directions: CareerDirection[] }) {
  const [kind, setKind] = useState("");
  const [direction, setDirection] = useState("");
  const [savedOnly, setSavedOnly] = useState(false);
  const [items, setItems] = useState<CareerOpportunity[]>([]);
  const [asOf, setAsOf] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Set<number>>(new Set());
  const pendingIds = useRef(new Set<number>());
  const refreshDeferred = useRef(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const load = useCallback(async () => {
    if (pendingIds.current.size) {
      refreshDeferred.current = true;
      return;
    }
    refreshDeferred.current = false;
    const current = ++revision.current;
    setLoading(true);
    setError("");
    const query = new URLSearchParams();
    if (kind) query.set("kind", kind);
    if (direction) query.set("direction_id", direction);
    if (savedOnly) query.set("saved", "true");
    try {
      const value = await api<{ items: CareerOpportunity[]; as_of: string }>(
        `/career/opportunities?${query}`,
      );
      if (current !== revision.current) return;
      setItems(value.items);
      setAsOf(value.as_of);
    } catch (cause) {
      if (current === revision.current) setError(message(cause));
    } finally {
      if (current === revision.current) setLoading(false);
    }
  }, [kind, direction, savedOnly]);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshVisible = () => {
      if (document.hidden) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (active) void load();
      }, 120);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === "qcareer:updated") refreshVisible();
    };
    void Promise.resolve().then(() => {
      if (active) void load();
    });
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("qcareer:updated", refreshVisible);
    window.addEventListener("qcareer:refresh", refreshVisible);
    window.addEventListener("storage", storage);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      active = false;
      mounted.current = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener("qcareer:updated", refreshVisible);
      window.removeEventListener("qcareer:refresh", refreshVisible);
      window.removeEventListener("storage", storage);
      document.removeEventListener("visibilitychange", refreshVisible);
      invalidate();
    };
  }, [load, invalidate]);
  async function save(item: CareerOpportunity) {
    if (pendingIds.current.has(item.id)) return;
    pendingIds.current.add(item.id);
    invalidate();
    setLoading(false);
    setPending((value) => new Set([...value, item.id]));
    setError("");
    try {
      const result = await api<{ saved: boolean }>(
        `/career/opportunities/${item.id}/save`,
        { method: item.saved ? "DELETE" : "PUT" },
      );
      setItems((value) =>
        value.flatMap((record) =>
          record.id === item.id
            ? savedOnly && !result.saved
              ? []
              : [{ ...record, saved: result.saved }]
            : [record],
        ),
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      pendingIds.current.delete(item.id);
      setPending((value) => {
        const next = new Set(value);
        next.delete(item.id);
        return next;
      });
      if (
        mounted.current &&
        !pendingIds.current.size &&
        refreshDeferred.current
      )
        void load();
    }
  }
  return (
    <>
      <div className={styles.sectionIntro}>
        <div>
          <h2>Где применить знания</h2>
          <p>
            Образование, курсы, стажировки и работа, опубликованные
            администраторами. Проверяйте условия на сайте организатора — это
            подборка, а не автоматический поиск вакансий.
          </p>
        </div>
        <Flag size={28} />
      </div>
      <div className={styles.filters}>
        <label className={styles.fieldLabel}>
          Тип возможности
          <select
            value={kind}
            disabled={pending.size > 0}
            onChange={(event) => setKind(event.target.value)}
            className={styles.select}
          >
            <option value="">Все варианты</option>
            {Object.entries(KIND_LABELS).map(([id, label]) => (
              <option value={id} key={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.fieldLabel}>
          Направление
          <select
            className={styles.select}
            value={direction}
            disabled={pending.size > 0}
            onChange={(event) => setDirection(event.target.value)}
          >
            <option value="">Все направления</option>
            {directions.map((item) => (
              <option value={item.id} key={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={savedOnly}
            disabled={pending.size > 0}
            onChange={(event) => setSavedOnly(event.target.checked)}
          />
          Сохранённые
        </label>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}{" "}
          <button className={styles.plainButton} onClick={() => void load()}>
            Повторить загрузку
          </button>
        </div>
      )}
      {loading ? (
        <div className={styles.loadingLine} role="status">
          <Loader2 className={styles.spinner} size={19} />
          Загружаем возможности…
        </div>
      ) : items.length ? (
        <>
          <p className={styles.updatedAt}>
            Подборка администрации · проверено на дату{" "}
            {careerDate(asOf) || "загрузки"}
          </p>
          <div className={styles.cardGrid}>
            {items.map((item) => {
              const href = careerExternalHref(item.url);
              return (
                <article className={styles.opportunity} key={item.id}>
                  <div className={styles.cardTop}>
                    <span className={styles.badge}>
                      {KIND_LABELS[item.kind]}
                    </span>
                    {item.direction_title && (
                      <span className={styles.badge}>
                        {item.direction_title}
                      </span>
                    )}
                  </div>
                  <h2>{item.title}</h2>
                  {item.organization && (
                    <p style={{ marginBottom: 10, fontWeight: 600 }}>
                      {item.organization}
                    </p>
                  )}
                  <p>{item.description}</p>
                  <div className={styles.opportunityMeta}>
                    {item.location && (
                      <span>
                        <MapPin
                          size={11}
                          style={{ display: "inline", marginRight: 4 }}
                        />
                        {item.location}
                      </span>
                    )}
                    {careerDate(item.expires_at) && (
                      <span>До {careerDate(item.expires_at)}</span>
                    )}
                  </div>
                  {careerPercent(item.readiness) !== null && (
                    <Coverage value={item.readiness} short />
                  )}
                  <div className={styles.opportunityActions}>
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.secondary}
                      >
                        Условия и подробности <ExternalLink size={13} />
                      </a>
                    ) : (
                      <span className={styles.muted}>
                        Уточните подробности у администратора.
                      </span>
                    )}
                    <button
                      className={styles.saveButton}
                      aria-label={
                        item.saved
                          ? "Убрать из сохранённого"
                          : "Сохранить возможность"
                      }
                      aria-pressed={!!item.saved}
                      disabled={pending.has(item.id)}
                      onClick={() => void save(item)}
                    >
                      {pending.has(item.id) ? (
                        <Loader2 className={styles.spinner} />
                      ) : (
                        <Bookmark />
                      )}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      ) : (
        !error && (
          <Empty
            title={
              savedOnly
                ? "Пока ничего не сохранено"
                : "Подходящих публикаций пока нет"
            }
          >
            {savedOnly
              ? "Снимите фильтр и нажмите значок закладки у интересной возможности."
              : "Измените фильтры или вернитесь позже. Администратор может добавить реальные образовательные и профессиональные возможности."}
          </Empty>
        )
      )}
    </>
  );
}

function Profile({
  profile,
  directions,
  save,
  busy,
}: {
  profile: CareerProfile;
  directions: CareerDirection[];
  save: (value: Partial<CareerProfile>) => Promise<boolean>;
  busy: boolean;
}) {
  const [target, setTarget] = useState(
    profile.target_direction_id?.toString() || "",
  );
  const [interests, setInterests] = useState(profile.interests.join(", "));
  const [about, setAbout] = useState(profile.about);
  const [success, setSuccess] = useState(false);
  const [localError, setLocalError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSuccess(false);
    setLocalError("");
    const values = careerInterests(interests);
    if (values.length > 12 || values.some((value) => value.length > 60)) {
      setLocalError(
        "Добавьте до 12 интересов, каждый — не длиннее 60 символов.",
      );
      return;
    }
    const result = await save({
      target_direction_id: target ? Number(target) : null,
      interests: values,
      about,
    });
    if (result) setSuccess(true);
  }
  return (
    <>
      <div className={styles.sectionIntro}>
        <div>
          <h2>Будущее начинается с вас</h2>
          <p>
            Интересы и цель помогают описать ваш выбор. Подтверждённые навыки
            рассчитываются отдельно по результатам обучения.
          </p>
        </div>
        <Settings2 size={28} />
      </div>
      <div className={styles.readOnly}>
        {profile.name}
        {profile.group_name ? ` · ${profile.group_name}` : ""}. Аккаунт общий с
        QStudy.{" "}
        <Link href="/dashboard/profile" className={styles.plainButton}>
          Изменить данные аккаунта <ArrowUpRight size={12} />
        </Link>
      </div>
      <form className={styles.profileForm} onSubmit={submit}>
        {localError && (
          <p className={styles.error} role="alert">
            {localError}
          </p>
        )}
        <label className={styles.fieldLabel}>
          Моё целевое направление
          <select
            className={styles.select}
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
              setSuccess(false);
            }}
          >
            <option value="">Пока выбираю</option>
            {directions.map((direction) => (
              <option value={direction.id} key={direction.id}>
                {direction.title}
              </option>
            ))}
          </select>
          <small>Цель можно изменить в любой момент.</small>
        </label>
        <label className={styles.fieldLabel}>
          Что мне интересно
          <input
            className={styles.input}
            value={interests}
            onChange={(event) => {
              setInterests(event.target.value);
              setSuccess(false);
            }}
            placeholder="Например, разработка, дизайн, аналитика"
            maxLength={900}
          />
          <small>Через запятую. До 12 интересов по 60 символов.</small>
        </label>
        <label className={styles.fieldLabel}>
          О себе и своих планах
          <textarea
            className={styles.textarea}
            value={about}
            onChange={(event) => {
              setAbout(event.target.value);
              setSuccess(false);
            }}
            maxLength={2000}
            placeholder="Какие задачи вам нравятся? Что хотите попробовать после обучения?"
          />
          <small>{about.length} / 2000</small>
        </label>
        <div className={styles.formFooter}>
          <button type="submit" disabled={busy} className={styles.primary}>
            {busy ? (
              <Loader2 size={16} className={styles.spinner} />
            ) : (
              <Check size={16} />
            )}
            Сохранить мои интересы
          </button>
          {success && (
            <p className={styles.success} role="status">
              Сохранено
            </p>
          )}
        </div>
      </form>
    </>
  );
}

export default function CareerWorkspace() {
  const { user } = useAuth();
  const {
    config,
    loading: configLoading,
    refresh: refreshConfig,
  } = useCareer();
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<CareerTab>("overview");
  const [busy, setBusy] = useState(false);
  const panelId = useId();
  const revision = useRef(0);
  const saving = useRef(false);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const load = useCallback(async () => {
    if (saving.current) return;
    const request = ++revision.current;
    setLoading(true);
    setError("");
    try {
      const value = await api<WorkspaceData>("/career/me");
      if (request === revision.current) setData(value);
    } catch (cause) {
      if (request === revision.current) setError(message(cause));
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshVisible = () => {
      if (document.hidden) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (active) void load();
      }, 120);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === "qcareer:updated") refreshVisible();
    };
    void Promise.resolve().then(() => {
      if (active) void load();
    });
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("qcareer:updated", refreshVisible);
    window.addEventListener("storage", storage);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      active = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener("qcareer:updated", refreshVisible);
      window.removeEventListener("storage", storage);
      document.removeEventListener("visibilitychange", refreshVisible);
      invalidate();
    };
  }, [load, invalidate]);
  useEffect(() => {
    const read = () => setTab(careerTab(window.location.hash.slice(1)));
    void Promise.resolve().then(read);
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  function navigate(value: CareerTab) {
    setTab(value);
    window.history.replaceState(null, "", `#${value}`);
  }
  async function saveProfile(value: Partial<CareerProfile>): Promise<boolean> {
    if (busy || saving.current) return false;
    saving.current = true;
    const request = ++revision.current;
    setBusy(true);
    setError("");
    try {
      await api<CareerProfile>("/career/profile", {
        method: "PATCH",
        body: JSON.stringify(value),
      });
      const updated = await api<WorkspaceData>("/career/me");
      if (request === revision.current) setData(updated);
      return true;
    } catch (cause) {
      setError(message(cause));
      return false;
    } finally {
      saving.current = false;
      setLoading(false);
      setBusy(false);
    }
  }
  return (
    <main className={styles.workspace} id="career-main">
      <div className={styles.workspaceTop}>
        <div>
          <p className={styles.eyebrow}>
            <span />
            МОЯ НОВАЯ ГЛАВА
          </p>
          <h1>Из знаний — в возможности.</h1>
          <p>Навыки, интересы и следующий шаг в одном пространстве.</p>
        </div>
        <div className={styles.workspaceIdentity}>
          <button
            type="button"
            className={styles.refreshButton}
            disabled={loading || busy}
            onClick={() => {
              void load();
              window.dispatchEvent(new Event("qcareer:refresh"));
            }}
            aria-label="Обновить учебные результаты"
            title="Обновить учебные результаты"
          >
            <RefreshCw
              size={17}
              className={loading ? styles.spinner : undefined}
            />
          </button>
          <span className={styles.avatar}>
            {(user.name || user.email).slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{user.name}</strong>
            <small>{data?.profile.group_name || "Аккаунт QStudy"}</small>
          </div>
        </div>
      </div>
      {configLoading && !config ? (
        <div className={styles.loadingLine} role="status">
          <Loader2 className={styles.spinner} size={20} />
          Открываем QCareer…
        </div>
      ) : config && !config.enabled && user.role !== "admin" ? (
        <Empty
          title="QCareer временно закрыт"
          action={
            <Link href="/dashboard" className={styles.primary}>
              Вернуться к учёбе <ArrowRight size={15} />
            </Link>
          }
        >
          Администратор отключил раздел. Ваши учебные данные и интересы
          сохраняются.
        </Empty>
      ) : !config ? (
        <Empty
          title="Не удалось открыть QCareer"
          action={
            <button
              className={styles.primary}
              onClick={() => void refreshConfig()}
            >
              Повторить <RefreshCw size={15} />
            </button>
          }
        >
          Проверьте подключение и попробуйте ещё раз.
        </Empty>
      ) : (
        <>
          <div
            className={styles.tabs}
            role="tablist"
            aria-label="Разделы личной траектории"
          >
            {TABS.map(({ id, title, icon: Icon }) => (
              <button
                id={`${panelId}-${id}`}
                key={id}
                role="tab"
                aria-selected={tab === id}
                aria-controls={`${panelId}-panel`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => navigate(id)}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const index = TABS.findIndex((item) => item.id === id);
                  const nextIndex =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? TABS.length - 1
                        : (index +
                            (event.key === "ArrowRight" ? 1 : -1) +
                            TABS.length) %
                          TABS.length;
                  const next = TABS[nextIndex].id;
                  navigate(next);
                  document.getElementById(`${panelId}-${next}`)?.focus();
                }}
              >
                <Icon size={16} />
                {title}
              </button>
            ))}
          </div>
          {error && (
            <div className={styles.error} role="alert">
              {error}
              {!data && (
                <button
                  className={styles.plainButton}
                  onClick={() => void load()}
                >
                  Повторить загрузку
                </button>
              )}
            </div>
          )}
          <section
            id={`${panelId}-panel`}
            role="tabpanel"
            aria-labelledby={`${panelId}-${tab}`}
            tabIndex={0}
          >
            {data &&
              user.role === "student" &&
              data.profile.group_id === null && (
                <div className={styles.readOnly}>
                  <strong>Учебная группа пока не назначена.</strong> Попросите
                  администратора добавить вас в вашу группу QStudy — тогда
                  появятся связанные силабусы, модули и учебные рекомендации.
                  Направления и возможности можно изучать уже сейчас.{" "}
                  <Link href="/developers" className={styles.plainButton}>
                    Связаться с администрацией <ArrowUpRight size={12} />
                  </Link>
                </div>
              )}
            {loading && !data ? (
              <div className={styles.status} role="status">
                <Loader2 className={styles.spinner} size={28} />
                <h2>Собираем вашу учебную историю</h2>
                <p>Проверяем навыки и доступные материалы.</p>
              </div>
            ) : data ? (
              <>
                {tab === "overview" && (
                  <Overview data={data} navigate={navigate} />
                )}{" "}
                {tab === "skills" && <Skills skills={data.skills} />}{" "}
                {tab === "directions" && (
                  <Directions
                    data={data}
                    choose={async (id) => {
                      await saveProfile({ target_direction_id: id });
                    }}
                    busy={busy}
                    navigate={navigate}
                  />
                )}{" "}
                {tab === "plan" && (
                  <Plan
                    recommendations={data.recommendations}
                    target={data.profile.target_direction_id}
                    hasGroup={
                      user.role === "admin" || data.profile.group_id !== null
                    }
                    navigate={navigate}
                  />
                )}{" "}
                {tab === "opportunities" && (
                  <Opportunities directions={data.directions} />
                )}{" "}
                {tab === "profile" && (
                  <Profile
                    profile={data.profile}
                    directions={data.directions}
                    save={saveProfile}
                    busy={busy}
                  />
                )}
                <p className={styles.disclaimer}>{data.disclaimer}</p>
              </>
            ) : (
              !error && (
                <Empty
                  title="Не удалось получить учебную историю"
                  action={
                    <button
                      className={styles.primary}
                      onClick={() => void load()}
                    >
                      Попробовать снова
                    </button>
                  }
                >
                  Попробуйте обновить данные.
                </Empty>
              )
            )}
          </section>
        </>
      )}
    </main>
  );
}
