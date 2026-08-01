package command

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestAgentsGetReadsRevisionedIDEFileAndDecodesRawContent(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("APPDATA", configRoot)

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/api/v1/environments/env-one/ide/file" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.URL.Query().Get("path") != agentsPath {
			t.Errorf("AGENTS path = %q", request.URL.Query().Get("path"))
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"data":{"path":"/workspace/AGENTS.md","name":"AGENTS.md","revision":"revision-one","encoding":"base64","content":"IyBJbnN0cnVjdGlvbnMK","kind":"text","editable":true}}`))
	}))
	defer server.Close()

	output := &bytes.Buffer{}
	app := New(Options{
		Out:        output,
		Err:        &bytes.Buffer{},
		Version:    "test",
		HTTPClient: server.Client(),
	})
	app.root.SetArgs([]string{
		"--endpoint", server.URL,
		"agents", "get",
		"--environment", "env-one",
		"--raw",
	})
	if err := app.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if output.String() != "# Instructions\n" {
		t.Fatalf("output = %q", output.String())
	}
}

func TestAgentsSetCreatesMissingFileThenUsesRevision(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("APPDATA", configRoot)
	t.Setenv("SANDPI_SESSION_COOKIE", "session-token")

	step := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		step++
		if request.Header.Get("Origin") != "" && request.Header.Get("Origin") != server.URL {
			t.Errorf("origin = %q", request.Header.Get("Origin"))
		}
		cookie, err := request.Cookie("sandpi_session")
		if err != nil || cookie.Value != "session-token" {
			t.Errorf("session cookie = %#v, error = %v", cookie, err)
		}
		response.Header().Set("Content-Type", "application/json")
		switch step {
		case 1:
			if request.Method != http.MethodGet || request.URL.Path != "/api/v1/environments/env-one/ide/file" {
				t.Errorf("step 1 = %s %s", request.Method, request.URL.Path)
			}
			if request.URL.Query().Get("path") != agentsPath {
				t.Errorf("AGENTS path = %q", request.URL.Query().Get("path"))
			}
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte(`{"error":{"code":"workspace_file_not_found","message":"missing"}}`))
		case 2:
			if request.Method != http.MethodPost || request.URL.Path != "/api/v1/environments/env-one/ide/entries" {
				t.Errorf("step 2 = %s %s", request.Method, request.URL.Path)
			}
			_, _ = response.Write([]byte(`{"data":{"created":true}}`))
		case 3:
			if request.Method != http.MethodGet {
				t.Errorf("step 3 method = %s", request.Method)
			}
			_, _ = response.Write([]byte(`{"data":{"revision":"revision-one"}}`))
		case 4:
			if request.Method != http.MethodPut || request.URL.Path != "/api/v1/environments/env-one/ide/file" {
				t.Errorf("step 4 = %s %s", request.Method, request.URL.Path)
			}
			var body struct {
				Encoding     string `json:"encoding"`
				Content      string `json:"content"`
				BaseRevision string `json:"baseRevision"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Errorf("decode AGENTS request: %v", err)
			}
			if body.Encoding != "base64" || body.BaseRevision != "revision-one" {
				t.Errorf("AGENTS request = %#v", body)
			}
			content, err := base64.StdEncoding.DecodeString(body.Content)
			if err != nil || string(content) != "# Environment instructions\n" {
				t.Errorf("AGENTS content = %q, error = %v", content, err)
			}
			_, _ = response.Write([]byte(`{"data":{"revision":"revision-two"}}`))
		default:
			t.Errorf("unexpected request %s %s", request.Method, request.URL.String())
			response.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer server.Close()

	output := &bytes.Buffer{}
	app := New(Options{
		In:         bytes.NewBufferString("# Environment instructions\n"),
		Out:        output,
		Err:        &bytes.Buffer{},
		Version:    "test",
		HTTPClient: server.Client(),
	})
	app.root.SetArgs([]string{
		"--endpoint", server.URL,
		"agents", "set",
		"--environment", "env-one",
		"--file", "-",
	})
	if err := app.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if step != 4 {
		t.Fatalf("requests = %d, want 4", step)
	}
	if output.String() != "{\n  \"revision\": \"revision-two\"\n}\n" {
		t.Fatalf("output = %q", output.String())
	}
}

func TestAgentsSetRequiresExplicitReplacementForExistingFile(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("APPDATA", configRoot)

	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		response.Header().Set("Content-Type", "application/json")
		if request.Method != http.MethodGet {
			t.Errorf("unexpected mutation %s %s", request.Method, request.URL.Path)
		}
		_, _ = response.Write([]byte(`{"data":{"revision":"revision-existing"}}`))
	}))
	defer server.Close()

	app := New(Options{
		In:         bytes.NewBufferString("replacement\n"),
		Out:        &bytes.Buffer{},
		Err:        &bytes.Buffer{},
		Version:    "test",
		HTTPClient: server.Client(),
	})
	app.root.SetArgs([]string{
		"--endpoint", server.URL,
		"agents", "set",
		"--environment", "env-one",
		"--file", "-",
	})
	err := app.ExecuteContext(context.Background())
	if err == nil || err.Error() != "AGENTS.md already exists; read and merge it, then pass --base-revision, or use --force to replace it" {
		t.Fatalf("error = %v", err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1", requests)
	}
}

func TestAgentsSetDoesNotCreateRemoteFileWhenLocalReadFails(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("APPDATA", configRoot)

	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		response.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	app := New(Options{
		Out:        &bytes.Buffer{},
		Err:        &bytes.Buffer{},
		Version:    "test",
		HTTPClient: server.Client(),
	})
	app.root.SetArgs([]string{
		"--endpoint", server.URL,
		"agents", "set",
		"--environment", "env-one",
		"--file", filepath.Join(t.TempDir(), "missing-AGENTS.md"),
	})
	if err := app.ExecuteContext(context.Background()); err == nil {
		t.Fatal("agents set succeeded with a missing local file")
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want 0", requests)
	}
}
