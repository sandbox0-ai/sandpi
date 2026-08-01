package deviceauth

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestDeviceAuthorizationDiscoversStartsAndPolls(t *testing.T) {
	var server *httptest.Server
	tokenPolls := 0
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/.well-known/openid-configuration":
			_, _ = fmt.Fprintf(response, `{"issuer":%q,"device_authorization_endpoint":%q,"token_endpoint":%q}`,
				server.URL, server.URL+"/oauth/device/code", server.URL+"/oauth/token")
		case "/oauth/device/code":
			assertForm(t, request, map[string]string{
				"client_id": "client-one",
				"scope":     "openid profile email",
			})
			_, _ = fmt.Fprintf(response, `{"device_code":"device-one","user_code":"ABCD-EFGH","verification_uri":%q,"verification_uri_complete":%q,"expires_in":600,"interval":1}`,
				server.URL+"/activate", server.URL+"/activate?user_code=ABCD-EFGH")
		case "/oauth/token":
			assertForm(t, request, map[string]string{
				"client_id":   "client-one",
				"device_code": "device-one",
				"grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
			})
			tokenPolls++
			if tokenPolls == 1 {
				response.WriteHeader(http.StatusForbidden)
				_, _ = response.Write([]byte(`{"error":"authorization_pending"}`))
				return
			}
			_, _ = response.Write([]byte(`{"access_token":"access-one","id_token":"id-one","token_type":"Bearer"}`))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client, err := New(server.URL, "client-one", "openid profile email", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	client.wait = func(context.Context, time.Duration) error { return nil }
	flow, err := client.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if flow.UserCode != "ABCD-EFGH" || flow.VerificationURL() != server.URL+"/activate?user_code=ABCD-EFGH" {
		t.Fatalf("flow = %#v", flow)
	}
	tokens, err := client.Poll(context.Background(), flow)
	if err != nil {
		t.Fatal(err)
	}
	if tokens.AccessToken != "access-one" || tokens.IDToken != "id-one" || tokenPolls != 2 {
		t.Fatalf("tokens = %#v, polls = %d", tokens, tokenPolls)
	}
}

func TestDeviceAuthorizationRejectsDiscoveryIssuerMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"issuer":"https://attacker.example","device_authorization_endpoint":"https://attacker.example/device","token_endpoint":"https://attacker.example/token"}`))
	}))
	defer server.Close()

	client, err := New(server.URL, "client-one", "openid", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Start(context.Background()); err == nil {
		t.Fatal("Start succeeded with mismatched discovery issuer")
	}
}

func TestDeviceAuthorizationReportsDenialWithoutLeakingTokens(t *testing.T) {
	client, err := New("https://identity.example", "client-one", "openid", nil)
	if err != nil {
		t.Fatal(err)
	}
	client.wait = func(context.Context, time.Duration) error { return nil }
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusForbidden)
		_, _ = response.Write([]byte(`{"error":"access_denied","error_description":"secret detail"}`))
	}))
	defer server.Close()
	client.httpClient = server.Client()
	flow := &Flow{DeviceCode: "private-device-code", ExpiresIn: 60, Interval: 1, tokenEndpoint: server.URL}
	if _, err := client.Poll(context.Background(), flow); err == nil || err.Error() != "device authorization was denied" {
		t.Fatalf("error = %v", err)
	}
}

func assertForm(t *testing.T, request *http.Request, expected map[string]string) {
	t.Helper()
	if request.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
		t.Errorf("content type = %q", request.Header.Get("Content-Type"))
	}
	if err := request.ParseForm(); err != nil {
		t.Fatalf("parse form: %v", err)
	}
	for key, value := range expected {
		if request.Form.Get(key) != value {
			t.Errorf("%s = %q, want %q", key, request.Form.Get(key), value)
		}
	}
	if _, err := url.ParseRequestURI(request.URL.String()); err != nil {
		t.Fatalf("request URL: %v", err)
	}
}
