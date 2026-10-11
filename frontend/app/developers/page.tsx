import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import Brand from "@/components/brand";
import { ProjectLogo } from "@/components/project-logo";
import { PublicDeveloperDirectory } from "@/components/developer-directory";
import "./developers.css";

export const metadata: Metadata = {
  title: "Связь с разработчиками",
  description:
    "Команда QForce: подразделения, руководители и официальные контакты разработчиков QStudy.",
};

export default function DevelopersPage() {
  return (
    <div className="dev-page">
      <header className="dev-header">
        <div className="dev-header-inner">
          <Brand />
          <nav aria-label="Навигация страницы команды">
            <Link href="/">Главная</Link>
            <Link href="/login" className="btn btn-dark">
              Войти <ArrowUpRight size={15} />
            </Link>
          </nav>
        </div>
      </header>
      <main className="dev-main">
        <Link href="/" className="dev-back">
          <ArrowLeft size={14} /> Назад в QStudy
        </Link>
        <section className="dev-hero" aria-labelledby="dev-page-title">
          <div className="dev-hero-copy">
            <p className="dev-eyebrow">QFORCE · КОМАНДА QSTUDY</p>
            <h1 id="dev-page-title">
              Связь с<br />
              разработчиками<span>.</span>
            </h1>
            <p className="dev-intro">
              Люди, которые создают QStudy. Подразделения, руководители и
              официальные контакты команды QForce.
            </p>
          </div>
          <div className="dev-main-logo">
            <ProjectLogo
              alt="QForce"
              fill
              unoptimized
              sizes="(max-width: 700px) 260px, 320px"
              style={{ objectFit: "contain" }}
            />
          </div>
        </section>
        <section
          className="dev-directory-section"
          aria-labelledby="dev-directory-title"
        >
          <div className="dev-section-heading">
            <p className="dev-eyebrow">НАША КОМАНДА</p>
            <h2 id="dev-directory-title">Подразделения QForce</h2>
            <p>
              Выберите нужное направление и познакомьтесь с его руководителем.
            </p>
          </div>
          <PublicDeveloperDirectory />
        </section>
      </main>
      <footer className="dev-footer">
        <div>
          <span>QStudy · QForce</span>
          <Link href="/">
            Вернуться в QStudy <ArrowUpRight size={14} />
          </Link>
        </div>
      </footer>
    </div>
  );
}
