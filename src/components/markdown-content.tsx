"use client";

import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
  onOpenWorkspacePath?: (path: string) => void;
}

const remarkPlugins = [remarkGfm];

function workspacePathFromHref(href: string | undefined) {
  if (!href) return undefined;
  const path = href.split(/[?#]/, 1)[0];
  if (path === "/workspace" || path.startsWith("/workspace/")) {
    try {
      return decodeURI(path);
    } catch {
      return path;
    }
  }
  return undefined;
}

function isExternalHref(href: string | undefined) {
  return Boolean(href && /^(?:https?:|mailto:)/i.test(href));
}

/** Shared presentation only; each harness still owns its native message model. */
export function MarkdownContent({
  content,
  onOpenWorkspacePath,
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
      const external = isExternalHref(href);
      return (
        <a
          href={href}
          title={title}
          target={external ? "_blank" : undefined}
          rel={external ? "noreferrer noopener" : undefined}
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
      return (
        <a
          className="markdown-image-link"
          href={typeof src === "string" ? src : undefined}
          target="_blank"
          rel="noreferrer noopener"
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
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
