"use client";

import Image from "next/image";
import Link from "next/link";
import { useCareer } from "./context";
import styles from "./career.module.css";

export default function CareerBrand() {
  const { config } = useCareer();
  return (
    <Link
      className={styles.brand}
      href="/qcareer"
      aria-label="QCareer — главная"
    >
      <span className={styles.brandMark}>
        <Image
          src={config?.logo_url || "/brand/qcareer-placeholder.svg"}
          alt=""
          width={42}
          height={42}
          unoptimized
        />
      </span>
      <span>
        {config?.title || "QCareer"}
        <small>из учёбы — в будущее</small>
      </span>
    </Link>
  );
}
