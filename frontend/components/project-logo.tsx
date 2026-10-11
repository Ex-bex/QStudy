"use client";

import Image, { type ImageProps } from "next/image";
import { useState } from "react";
import { DEFAULT_PROJECT_LOGO } from "@/lib/branding";
import { useBranding } from "@/components/branding-provider";

export function ProjectLogo(props: Omit<ImageProps, "src">) {
  const { branding } = useBranding();
  const [failedSource, setFailedSource] = useState("");
  const src =
    failedSource === branding.project_logo_url
      ? DEFAULT_PROJECT_LOGO
      : branding.project_logo_url;
  return (
    <Image
      {...props}
      src={src}
      unoptimized
      onError={() => setFailedSource(branding.project_logo_url)}
    />
  );
}
