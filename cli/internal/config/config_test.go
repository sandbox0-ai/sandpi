package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSaveAndLoadProtectedConfig(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("APPDATA", configRoot)

	want := Config{
		Endpoint:      "https://sandpi.example",
		SessionCookie: "session-token",
	}
	if err := Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("Load() = %#v, want %#v", got, want)
	}
	path, err := Path()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(path) != filepath.Join(configRoot, "sandpi") {
		t.Fatalf("config path = %s", path)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("config mode = %o, want 600", info.Mode().Perm())
		}
	}
}

func TestLoadMissingConfig(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("APPDATA", configRoot)

	got, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got != (Config{}) {
		t.Fatalf("Load() = %#v", got)
	}
}
