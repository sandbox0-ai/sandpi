package command

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCollectSkillFilesPreservesExecutableAndSkipsGit(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "SKILL.md"), []byte("---\nname: release\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "scripts"), 0o700); err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(root, "scripts", "release.sh")
	if err := os.WriteFile(scriptPath, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(scriptPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "config"), []byte("ignored"), 0o600); err != nil {
		t.Fatal(err)
	}

	files, err := collectSkillFiles(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("files = %#v", files)
	}
	byPath := make(map[string]skillFile, len(files))
	for _, file := range files {
		byPath[file.Path] = file
	}
	manifest := byPath["SKILL.md"]
	manifestContent, err := base64.StdEncoding.DecodeString(manifest.ContentBase64)
	if err != nil {
		t.Fatal(err)
	}
	if string(manifestContent) != "---\nname: release\n---\n" || manifest.Executable {
		t.Fatalf("manifest = %#v", manifest)
	}
	if !byPath["scripts/release.sh"].Executable {
		t.Fatalf("script = %#v", byPath["scripts/release.sh"])
	}
}

func TestCollectSkillFilesRejectsMissingManifest(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("missing manifest"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := collectSkillFiles(root); err == nil {
		t.Fatal("collectSkillFiles succeeded without SKILL.md")
	}
}

func TestCollectSkillFilesRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires additional Windows privileges")
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "SKILL.md"), []byte("manifest"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("SKILL.md", filepath.Join(root, "linked.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := collectSkillFiles(root); err == nil {
		t.Fatal("collectSkillFiles accepted a symlink")
	}
}
