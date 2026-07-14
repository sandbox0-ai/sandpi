import { FlatCompat } from "@eslint/eslintrc";
import path from "node:path";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const directory = path.dirname(filename);
const compat = new FlatCompat({ baseDirectory: directory });

const config = [
  {
    ignores: [
      ".next/**",
      "dist/**",
      "node_modules/**",
      "out/**",
      "public/monaco/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
