"use client";

import React, {
  memo,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  type Components,
  defaultUrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";

import { sandboxLoopbackUrl } from "@/lib/sandbox-loopback-url";
import { resolveWorkspaceMarkdownPath } from "@/lib/workspace-file-presentation";

interface MarkdownContentProps {
  content: string;
  variant?: "message" | "document";
  baseWorkspacePath?: string;
  onOpenWorkspacePath?: (path: string) => void;
  renderWorkspaceImage?: (path: string, alt: string) => ReactNode;
}

const remarkPlugins = [remarkGfm];
// Intentionally omit rehypeRaw so pasted HTML stays visible as inert text.

function posixAbsolutePathFromHref(href: string | undefined) {
  if (!href) return undefined;
  const path = href.split(/[?#]/, 1)[0];
  if (!path.startsWith("/") || path.startsWith("//")) return undefined;
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function workspacePathFromHref(
  href: string | undefined,
  baseWorkspacePath?: string,
) {
  return resolveWorkspaceMarkdownPath(href, baseWorkspacePath);
}

function isExternalHref(href: string | undefined) {
  return Boolean(href && /^(?:https?:|mailto:)/i.test(href));
}

function markdownUrlTransform(
  value: string,
  key: string,
) {
  if (key === "href" && sandboxLoopbackUrl(value)) {
    return value;
  }
  return defaultUrlTransform(value);
}

/** Shared presentation only; each harness still owns its native message model. */
function MarkdownContentView({
  content,
  variant = "message",
  baseWorkspacePath,
  onOpenWorkspacePath,
  renderWorkspaceImage,
}: MarkdownContentProps) {
  const components = useMemo<Components>(
    () => ({
      a({ href, children, title }) {
        const workspacePath = workspacePathFromHref(href, baseWorkspacePath);
        if (workspacePath && onOpenWorkspacePath) {
          return (
            <button
              type="button"
              className="markdown-workspace-link"
              title={title ?? workspacePath}
              data-workspace-path={workspacePath}
              onClick={() => onOpenWorkspacePath(workspacePath)}
            >
              {children}
            </button>
          );
        }
        const absolutePath = posixAbsolutePathFromHref(href);
        if (absolutePath) {
          return (
            <code
              className="markdown-local-path"
              title={title ?? absolutePath}
              data-local-path={absolutePath}
            >
              {absolutePath}
            </code>
          );
        }
        const sandboxUrl = sandboxLoopbackUrl(href);
        if (sandboxUrl) {
          return (
            <code
              className="markdown-local-url"
              title={title ?? sandboxUrl}
              data-sandbox-loopback-url={sandboxUrl}
            >
              {children}
            </code>
          );
        }
        const external = isExternalHref(href);
        return (
          <a
            href={href}
            title={title}
            target={external ? "_blank" : undefined}
            rel={external ? "noreferrer noopener" : undefined}
            data-sandpi-external-link={external ? "" : undefined}
          >
            {children}
          </a>
        );
      },
      table({ children }) {
        return (
          <div className="markdown-table-scroll">
            <table>{children}</table>
          </div>
        );
      },
      img({ alt, src }) {
        const href = typeof src === "string" ? src : undefined;
        const workspacePath = workspacePathFromHref(href, baseWorkspacePath);
        if (workspacePath && renderWorkspaceImage) {
          return <>{renderWorkspaceImage(workspacePath, alt || "Workspace image")}</>;
        }
        if (workspacePath && onOpenWorkspacePath) {
          return (
            <button
              type="button"
              className="markdown-workspace-link markdown-image-link"
              data-workspace-path={workspacePath}
              onClick={() => onOpenWorkspacePath(workspacePath)}
            >
              {alt || "Open image"}
            </button>
          );
        }
        const external = isExternalHref(href);
        return (
          <a
            className="markdown-image-link"
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            data-sandpi-external-link={external ? "" : undefined}
          >
            {alt || "Open image"}
          </a>
        );
      },
    }),
    [
      baseWorkspacePath,
      onOpenWorkspacePath,
      renderWorkspaceImage,
    ],
  );
  const transformUrl = useCallback(
    (value: string, key: string) => markdownUrlTransform(value, key),
    [],
  );

  return (
    <div
      className={`markdown-content${
        variant === "document" ? " markdown-content-document" : ""
      }`}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={components}
        urlTransform={transformUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownContent = memo(MarkdownContentView);
