import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import Image from "next/image";
import { PublicDeveloperDirectory } from "@/components/developer-directory";
import "./developers.css";

export const metadata: Metadata = {
  title: { absolute: "Команда и контакты · QForce" },
  description:
    "Команда QForce: подразделения, руководители и официальные контакты разработчиков проектов экосистемы.",
};

export default function DevelopersPage() {
  return (
    <div className="dev-page">
      <header className="dev-header">
        <div className="dev-header-inner">
          <Link href="/" className="brand" aria-label="QForce — главная">
            <Image
              src="/brand/qforce_logo_main.png"
              alt=""
              width={38}
              height={38}
              unoptimized
            />
            <span>QForce</span>
          </Link>
          <nav aria-label="Навигация страницы команды">
            <Link href="/">Главная</Link>
            <Link href="/qcareer">QCareer</Link>
            <Link href="/login" className="btn btn-dark">
              Войти <ArrowUpRight size={15} />
            </Link>
          </nav>
        </div>
      </header>
      <main className="dev-main">
        <Link href="/" className="dev-back">
          <ArrowLeft size={14} /> На главную QForce
        </Link>
        <section className="dev-hero" aria-labelledby="dev-page-title">
          <div className="dev-hero-copy">
            <p className="dev-eyebrow">QFORCE · КОМАНДА ЭКОСИСТЕМЫ</p>
            <h1 id="dev-page-title">
              Связь с<br />
              разработчиками<span>.</span>
            </h1>
            <p className="dev-intro">
              Люди, которые создают проекты экосистемы. Подразделения,
              руководители и официальные контакты команды QForce.
            </p>
          </div>
          <div className="dev-main-logo">
            <Image
              src="/brand/qforce_logo_main.png"
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
          <span>Команда QForce</span>
          <Link href="/">
            Главная QForce <ArrowUpRight size={14} />
          </Link>
        </div>
      </footer>
    </div>
  );
}
