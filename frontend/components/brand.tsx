import Link from "next/link";
import { ProjectLogo } from "@/components/project-logo";

export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-symbol ${className}`} aria-hidden="true">
      <ProjectLogo
        alt=""
        width={42}
        height={42}
        sizes="42px"
        unoptimized
        className="brand-image"
      />
    </span>
  );
}

export default function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="brand" aria-label="QStudy — главная">
      <BrandMark />
      {!compact && (
        <span>
          QStudy<span className="brand-dot">.</span>
        </span>
      )}
    </Link>
  );
}
