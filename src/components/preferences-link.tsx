"use client";

import Link from "next/link";
import { type ComponentProps, useEffect, useState } from "react";

import { preferencesUrl } from "@/lib/preferences-navigation";

type PreferencesLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  parameters?: Record<string, string>;
};

/** Links to Preferences while retaining the exact in-app location to return to. */
export function PreferencesLink({
  parameters,
  ...props
}: PreferencesLinkProps) {
  const [returnTo, setReturnTo] = useState("/");

  useEffect(() => {
    setReturnTo(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    );
  }, []);

  return <Link {...props} href={preferencesUrl(returnTo, parameters)} />;
}
