"use client";

import { useEffect } from "react";

import {
  activateNativeChromeSurfaces,
  type NativeChromeSurface,
} from "./client-preferences";

export function useNativeChromeSurfaces(
  top: NativeChromeSurface,
  bottom: NativeChromeSurface,
) {
  useEffect(
    () => activateNativeChromeSurfaces({ top, bottom }),
    [bottom, top],
  );
}
