import Link from "next/link";
import { Compass } from "lucide-react";
import styles from "./nav-link.module.css";

export default function CareerNavLink() {
  return (
    <Link
      href="/qcareer/workspace"
      className={styles.link}
      aria-label="QCareer · мой карьерный путь"
    >
      <Compass size={14} />
      <span>QCareer</span>
    </Link>
  );
}
