"use client";

import React from "react";
import ReactMarkdown, {
  type Components,
  defaultUrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";

import { sandboxLoopbackUrl } from "@/lib/environment-browser";

interface MarkdownContentProps {
  content: string;
  onOpenWorkspacePath?: (path: string) => void;
  onOpenBrowserUrl?: (url: string) => void;
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

function workspacePathFromHref(href: string | undefined) {
  const path = posixAbsolutePathFromHref(href);
  return path === "/workspace" || path?.startsWith("/workspace/")
    ? path
    : undefined;
}

function isExternalHref(href: string | undefined) {
  return Boolean(href && /^(?:https?:|mailto:)/i.test(href));
}

function markdownUrlTransform(
  value: string,
  key: string,
  allowLoopbackLinks: boolean,
) {
  if (allowLoopbackLinks && key === "href" && sandboxLoopbackUrl(value)) {
    return value;
  }
  return defaultUrlTransform(value);
}

/** Shared presentation only; each harness still owns its native message model. */
export function MarkdownContent({
  content,
  onOpenWorkspacePath,
  onOpenBrowserUrl,
}: MarkdownContentProps) {
  const components: Components = {
    a({ href, children, title }) {
      const workspacePath = workspacePathFromHref(href);
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
      const browserUrl = sandboxLoopbackUrl(href);
      if (browserUrl && onOpenBrowserUrl) {
        return (
          <button
            type="button"
            className="markdown-browser-link"
            title={title ?? browserUrl}
            data-browser-url={browserUrl}
            onClick={() => onOpenBrowserUrl(browserUrl)}
          >
            {children}
          </button>
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
  };

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={components}
        urlTransform={(value, key) =>
          markdownUrlTransform(value, key, Boolean(onOpenBrowserUrl))
        }
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
