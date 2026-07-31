"use client";

import Editor, {
  DiffEditor,
  loader,
  type DiffOnMount,
  type OnMount,
} from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";

import type { WorkspaceLineChange } from "@/lib/types";

import styles from "./workspace-code-editor.module.css";

loader.config({ paths: { vs: "/monaco/vs" } });

interface WorkspaceCodeEditorProps {
  modelPath: string;
  value: string;
  language: string;
  readOnly: boolean;
  lineChanges: WorkspaceLineChange[];
  onChange(value: string): void;
  onSave(): void;
}

function resolvedMonacoTheme() {
  if (typeof document === "undefined") return "vs";
  return document.documentElement.dataset.resolvedTheme === "dark" ? "vs-dark" : "vs";
}

function useMonacoTheme() {
  const [theme, setTheme] = useState(resolvedMonacoTheme);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(resolvedMonacoTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-resolved-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function editorOptions(readOnly: boolean): Monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    contextmenu: true,
    cursorBlinking: "smooth",
    cursorSmoothCaretAnimation: "on",
    fixedOverflowWidgets: true,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontLigatures: false,
    fontSize: 12,
    glyphMargin: false,
    lineDecorationsWidth: 7,
    lineHeight: 20,
    minimap: { enabled: false },
    padding: { top: 8, bottom: 18 },
    readOnly,
    domReadOnly: readOnly,
    renderLineHighlight: "line",
    roundedSelection: false,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    stickyScroll: { enabled: false },
    tabSize: 2,
    wordWrap: "on",
  };
}

function decorations(
  monaco: typeof Monaco,
  changes: WorkspaceLineChange[],
): Monaco.editor.IModelDeltaDecoration[] {
  return changes.flatMap((change) => {
    if (change.placement || change.line < 1) return [];
    return [
      {
        range: new monaco.Range(change.line, 1, change.line, 1),
        options: {
          isWholeLine: true,
          className: `sandpi-line-${change.kind}`,
          linesDecorationsClassName: `sandpi-gutter-${change.kind}`,
          overviewRuler: {
            color:
              change.kind === "added"
                ? "#38a169"
                : change.kind === "deleted"
                  ? "#dc5b5b"
                  : "#d49b31",
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      },
    ];
  });
}

export function WorkspaceCodeEditor({
  modelPath,
  value,
  language,
  readOnly,
  lineChanges,
  onChange,
  onSave,
}: WorkspaceCodeEditorProps) {
  const theme = useMonacoTheme();
  const saveRef = useRef(onSave);
  const decorationsRef = useRef<
    Monaco.editor.IEditorDecorationsCollection | undefined
  >(undefined);
  const editorRef = useRef<Parameters<OnMount>[0] | undefined>(undefined);
  const monacoRef = useRef<Parameters<OnMount>[1] | undefined>(undefined);
  saveRef.current = onSave;

  const applyDecorations = () => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    decorationsRef.current?.clear();
    decorationsRef.current = editor.createDecorationsCollection(
      decorations(monaco, lineChanges),
    );
  };

  useEffect(applyDecorations, [lineChanges]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    applyDecorations();
    editor.addAction({
      id: "sandpi.workspace.save",
      label: "Save Workspace file",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => saveRef.current(),
    });
  };

  return (
    <Editor
      path={modelPath}
      value={value}
      language={language}
      theme={theme}
      loading={
        <textarea
          className={styles.fallback}
          aria-label={`Plain text editor for ${
            modelPath.split("/").at(-1) ?? "Workspace file"
          }`}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              onSave();
            }
          }}
        />
      }
      options={editorOptions(readOnly)}
      onChange={(next) => onChange(next ?? "")}
      onMount={handleMount}
      keepCurrentModel
      saveViewState
    />
  );
}

interface WorkspaceConflictDiffProps {
  modelPath: string;
  latest: string;
  local: string;
  language: string;
}

export function WorkspaceConflictDiff({
  modelPath,
  latest,
  local,
  language,
}: WorkspaceConflictDiffProps) {
  const theme = useMonacoTheme();
  const handleMount: DiffOnMount = (editor) => {
    editor.getModifiedEditor().focus();
  };
  return (
    <DiffEditor
      originalModelPath={`${modelPath}?revision=latest`}
      modifiedModelPath={`${modelPath}?revision=local`}
      original={latest}
      modified={local}
      language={language}
      theme={theme}
      loading={<span>Loading comparison…</span>}
      options={{
        ...editorOptions(true),
        enableSplitViewResizing: true,
        originalEditable: false,
        renderSideBySide: true,
      }}
      onMount={handleMount}
    />
  );
}
