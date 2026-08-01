package command

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	localconfig "github.com/sandbox0-ai/sandpi/cli/internal/config"
)

func TestParseNativeCallback(t *testing.T) {
	attemptID, code, err := parseNativeCallback(
		"sandpi://auth/callback?attempt_id=native-one&code=code-one&state=state-one",
		"state-one",
	)
	if err != nil {
		t.Fatal(err)
	}
	if attemptID != "native-one" || code != "code-one" {
		t.Fatalf("callback = (%q, %q)", attemptID, code)
	}
}

func TestParseNativeCallbackRejectsWrongStateAndOrigin(t *testing.T) {
	for _, callback := range []string{
		"https://auth/callback?attempt_id=one&code=two&state=expected",
		"sandpi://other/callback?attempt_id=one&code=two&state=expected",
		"sandpi://auth/callback?attempt_id=one&code=two&state=wrong",
		"sandpi://auth/callback?state=expected",
	} {
		if _, _, err := parseNativeCallback(callback, "expected"); err == nil {
			t.Fatalf("parseNativeCallback(%q) succeeded", callback)
		}
	}
}

func TestAuthLoginCompletesPKCEAndStoresSandpiSession(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("APPDATA", configRoot)
	t.Setenv("SANDPI_SESSION_COOKIE", "")

	stateReady := make(chan string, 1)
	reader, writer := io.Pipe()
	go func() {
		state := <-stateReady
		callback := &url.URL{Scheme: "sandpi", Host: "auth", Path: "/callback"}
		query := callback.Query()
		query.Set("attempt_id", "native-one")
		query.Set("code", "handoff-code")
		query.Set("state", state)
		callback.RawQuery = query.Encode()
		_, _ = fmt.Fprintln(writer, callback.String())
		_ = writer.Close()
	}()

	var verifier string
	requests := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Method != http.MethodGet && request.Header.Get("Origin") != server.URL {
			t.Errorf("origin = %q", request.Header.Get("Origin"))
		}
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v1/auth/native/prepare":
			var body struct {
				Verifier string `json:"verifier"`
				State    string `json:"state"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Errorf("decode prepare: %v", err)
			}
			verifier = body.Verifier
			stateReady <- body.State
			_, _ = response.Write([]byte(`{"data":{"authorizationUrl":"` + server.URL + `/sign-in"}}`))
		case "/api/v1/auth/native/complete":
			var body struct {
				AttemptID string `json:"attemptId"`
				Code      string `json:"code"`
				Verifier  string `json:"verifier"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Errorf("decode complete: %v", err)
			}
			if body.AttemptID != "native-one" || body.Code != "handoff-code" || body.Verifier != verifier {
				t.Errorf("completion = %#v", body)
			}
			http.SetCookie(response, &http.Cookie{Name: "sandpi_session", Value: "session-token", Path: "/"})
			_, _ = response.Write([]byte(`{"data":{"returnTo":"/"}}`))
		case "/api/v1/auth/me":
			cookie, err := request.Cookie("sandpi_session")
			if err != nil || cookie.Value != "session-token" {
				t.Errorf("session cookie = %#v, error = %v", cookie, err)
			}
			_, _ = response.Write([]byte(`{"data":{"userId":"user-one","kind":"oidc"}}`))
		default:
			t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	output := &bytes.Buffer{}
	errorsOutput := &bytes.Buffer{}
	app := New(Options{
		In:         reader,
		Out:        output,
		Err:        errorsOutput,
		Version:    "test",
		HTTPClient: server.Client(),
	})
	app.root.SetArgs([]string{
		"--endpoint", server.URL,
		"auth", "login",
		"--no-open",
	})
	if err := app.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if requests != 3 {
		t.Fatalf("requests = %d, want 3", requests)
	}
	var principal map[string]string
	if err := json.Unmarshal(output.Bytes(), &principal); err != nil {
		t.Fatalf("decode output %q: %v", output.String(), err)
	}
	if principal["userId"] != "user-one" || principal["kind"] != "oidc" {
		t.Fatalf("output = %#v", principal)
	}
	if !bytes.Contains(errorsOutput.Bytes(), []byte(server.URL+"/sign-in")) {
		t.Fatalf("login instructions = %q", errorsOutput.String())
	}
	stored, err := localconfig.Load()
	if err != nil {
		t.Fatal(err)
	}
	if stored.Endpoint != server.URL || stored.SessionCookie != "session-token" {
		t.Fatalf("stored config = %#v", stored)
	}
}
