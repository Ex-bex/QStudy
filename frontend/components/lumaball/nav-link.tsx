import Link from "next/link";
import { Gamepad2 } from "lucide-react";
import styles from "./nav-link.module.css";

export default function LumaNavLink() {
  return (
    <Link href="/qball" className={styles.link}>
      <Gamepad2 size={15} />
      <span>QBall</span>
    </Link>
  );
}
