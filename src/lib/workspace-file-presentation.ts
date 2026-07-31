export type WorkspaceTextPresentation = "csv" | "markdown" | "source";

function extensionOf(fileName: string) {
  const baseName = fileName.split("/").at(-1) ?? fileName;
  const separator = baseName.lastIndexOf(".");
  return separator < 0 ? "" : baseName.slice(separator + 1).toLowerCase();
}

export function workspaceTextPresentationForName(
  fileName: string,
): WorkspaceTextPresentation {
  const extension = extensionOf(fileName);
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "csv" || extension === "tsv") return "csv";
  return "source";
}

function pathWithoutQueryOrFragment(value: string) {
  return value.split(/[?#]/, 1)[0] ?? "";
}

function pathWithoutTextPosition(value: string) {
  const separator = value.lastIndexOf("/");
  const directory = value.slice(0, separator + 1);
  const baseName = value.slice(separator + 1);
  const positioned = baseName.match(/^(.+?):[1-9]\d*(?::[1-9]\d*)?$/);
  return positioned ? `${directory}${positioned[1]}` : value;
}

/** Resolves an inert Markdown link without allowing it to escape /workspace. */
export function resolveWorkspaceMarkdownPath(
  href: string | undefined,
  sourcePath?: string,
) {
  if (!href || href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href)) {
    return undefined;
  }
  let decoded = pathWithoutQueryOrFragment(href);
  try {
    decoded = decodeURI(decoded);
  } catch {
    // Preserve malformed URL text as a non-navigable link.
    return undefined;
  }
  if (!decoded || decoded.startsWith("#")) return undefined;
  decoded = pathWithoutTextPosition(decoded);

  const segments = decoded.startsWith("/")
    ? decoded.split("/")
    : sourcePath
      ? `${sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1)}${decoded}`.split(
          "/",
        )
      : [];
  if (segments.length === 0) return undefined;
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  const resolved = `/${normalized.join("/")}`;
  return resolved === "/workspace" || resolved.startsWith("/workspace/")
    ? resolved
    : undefined;
}
