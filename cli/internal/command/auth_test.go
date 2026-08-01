package command

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	localconfig "github.com/sandbox0-ai/sandpi/cli/internal/config"
)

func TestAuthLoginCompletesDeviceAuthorizationAndStoresSandpiSession(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("APPDATA", configRoot)
	t.Setenv("SANDPI_SESSION_COOKIE", "")

	var identity *httptest.Server
	identity = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/.well-known/openid-configuration":
			_, _ = fmt.Fprintf(response, `{"issuer":%q,"device_authorization_endpoint":%q,"token_endpoint":%q}`,
				identity.URL, identity.URL+"/oauth/device/code", identity.URL+"/oauth/token")
		case "/oauth/device/code":
			if err := request.ParseForm(); err != nil {
				t.Fatalf("parse device form: %v", err)
			}
			if request.Form.Get("client_id") != "cli-client" || request.Form.Get("scope") != "openid profile email" {
				t.Errorf("device form = %v", request.Form)
			}
			_, _ = fmt.Fprintf(response, `{"device_code":"device-one","user_code":"ABCD-EFGH","verification_uri":%q,"verification_uri_complete":%q,"expires_in":600,"interval":1}`,
				identity.URL+"/activate", identity.URL+"/activate?user_code=ABCD-EFGH")
		case "/oauth/token":
			if err := request.ParseForm(); err != nil {
				t.Fatalf("parse token form: %v", err)
			}
			if request.Form.Get("client_id") != "cli-client" || request.Form.Get("device_code") != "device-one" {
				t.Errorf("token form = %v", request.Form)
			}
			_, _ = response.Write([]byte(`{"access_token":"device-access-token","id_token":"device-id-token","token_type":"Bearer"}`))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer identity.Close()

	requests := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Method != http.MethodGet && request.Header.Get("Origin") != server.URL {
			t.Errorf("origin = %q", request.Header.Get("Origin"))
		}
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v1/auth/device/config":
			_, _ = fmt.Fprintf(response, `{"data":{"mode":"oidc","issuer":%q,"clientId":"cli-client","scopes":"openid profile email"}}`, identity.URL)
		case "/api/v1/auth/device/complete":
			var body struct {
				AccessToken string `json:"accessToken"`
				IDToken     string `json:"idToken"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Errorf("decode completion: %v", err)
			}
			if body.AccessToken != "device-access-token" {
				t.Errorf("access token = %q", body.AccessToken)
			}
			if body.IDToken != "device-id-token" {
				t.Errorf("id token = %q", body.IDToken)
			}
			http.SetCookie(response, &http.Cookie{Name: "sandpi_session", Value: "session-token", Path: "/api/v1"})
			_, _ = response.Write([]byte(`{"data":{"returnTo":"/"}}`))
		case "/api/v1/auth/me":
			cookie, err := request.Cookie("sandpi_session")
			if err != nil || cookie.Value != "session-token" {
				t.Errorf("session cookie = %#v, error = %v", cookie, err)
			}
			_, _ = response.Write([]byte(`{"data":{"userId":"user-one","kind":"oidc-session"}}`))
		default:
			t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	output := &bytes.Buffer{}
	errorsOutput := &bytes.Buffer{}
	app := New(Options{
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
		t.Fatalf("Sandpi requests = %d, want 3", requests)
	}
	var principal map[string]string
	if err := json.Unmarshal(output.Bytes(), &principal); err != nil {
		t.Fatalf("decode output %q: %v", output.String(), err)
	}
	if principal["userId"] != "user-one" || principal["kind"] != "oidc-session" {
		t.Fatalf("output = %#v", principal)
	}
	if !bytes.Contains(errorsOutput.Bytes(), []byte(identity.URL+"/activate?user_code=ABCD-EFGH")) ||
		!bytes.Contains(errorsOutput.Bytes(), []byte("ABCD-EFGH")) {
		t.Fatalf("login instructions = %q", errorsOutput.String())
	}
	stored, err := localconfig.Load()
	if err != nil {
		t.Fatal(err)
	}
	if stored.Endpoint != server.URL || stored.SessionCookie != "session-token" || stored.SignedOut {
		t.Fatalf("stored config = %#v", stored)
	}
}

func TestAuthLoginRestoresBuiltinAdminModeWithoutExternalFlow(t *testing.T) {
	configRoot := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configRoot)
	t.Setenv("APPDATA", configRoot)
	if err := localconfig.Save(localconfig.Config{Endpoint: "https://old.example", SignedOut: true}); err != nil {
		t.Fatal(err)
	}

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v1/auth/device/config":
			_, _ = response.Write([]byte(`{"data":{"mode":"admin"}}`))
		case "/api/v1/auth/me":
			if _, err := request.Cookie("sandpi_signed_out"); err == nil {
				t.Error("signed-out cookie was retained")
			}
			_, _ = response.Write([]byte(`{"data":{"userId":"user-admin","kind":"builtin-admin"}}`))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	output := &bytes.Buffer{}
	app := New(Options{Out: output, Err: &bytes.Buffer{}, Version: "test", HTTPClient: server.Client()})
	app.root.SetArgs([]string{"--endpoint", server.URL, "auth", "login", "--no-open"})
	if err := app.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored, err := localconfig.Load()
	if err != nil {
		t.Fatal(err)
	}
	if stored.Endpoint != server.URL || stored.SessionCookie != "" || stored.SignedOut {
		t.Fatalf("stored config = %#v", stored)
	}
}
