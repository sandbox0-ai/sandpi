package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDataSendsSandpiSessionAndMutationOrigin(t *testing.T) {
	t.Helper()
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut {
			t.Errorf("method = %s, want PUT", request.Method)
		}
		if request.URL.Path != "/prefix/api/v1/example" {
			t.Errorf("path = %s", request.URL.Path)
		}
		if request.URL.Query().Get("detail") != "full" {
			t.Errorf("detail query = %q", request.URL.Query().Get("detail"))
		}
		if request.Header.Get("Origin") != server.URL {
			t.Errorf("origin = %q, want %q", request.Header.Get("Origin"), server.URL)
		}
		if request.Header.Get("User-Agent") != "sandpi-cli/test" {
			t.Errorf("user agent = %q", request.Header.Get("User-Agent"))
		}
		cookie, err := request.Cookie("sandpi_session")
		if err != nil || cookie.Value != "session-token" {
			t.Errorf("session cookie = %#v, error = %v", cookie, err)
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		var decoded map[string]string
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		if decoded["value"] != "updated" {
			t.Errorf("request value = %q", decoded["value"])
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"data":{"ok":true}}`))
	}))
	defer server.Close()

	client, err := New(server.URL+"/prefix", "session-token", false, "sandpi-cli/test", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	data, err := client.Data(
		context.Background(),
		http.MethodPut,
		"/api/v1/example?detail=full",
		map[string]string{"value": "updated"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"ok":true}` {
		t.Fatalf("data = %s", data)
	}
}

func TestDoDecodesStableAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusConflict)
		_, _ = response.Write([]byte(`{"error":{"code":"revision_conflict","message":"The file changed.","requestId":"request-one","details":{"revision":"two"}}}`))
	}))
	defer server.Close()

	client, err := New(server.URL, "", false, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Do(context.Background(), http.MethodGet, "/api/v1/example", nil)
	apiError, ok := err.(*Error)
	if !ok {
		t.Fatalf("error = %#v, want *api.Error", err)
	}
	if apiError.StatusCode != http.StatusConflict || apiError.Code != "revision_conflict" {
		t.Fatalf("error = %#v", apiError)
	}
	if apiError.RequestID != "request-one" || string(apiError.Details) != `{"revision":"two"}` {
		t.Fatalf("error metadata = %#v", apiError)
	}
}

func TestDoSendsBuiltinSignedOutCookieWithoutSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		cookie, err := request.Cookie("sandpi_signed_out")
		if err != nil || cookie.Value != "1" {
			t.Errorf("signed-out cookie = %#v, error = %v", cookie, err)
		}
		if _, err := request.Cookie("sandpi_session"); err == nil {
			t.Error("unexpected Sandpi session cookie")
		}
		_, _ = response.Write([]byte(`{"data":null}`))
	}))
	defer server.Close()

	client, err := New(server.URL, "", true, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Data(context.Background(), http.MethodGet, "/api/v1/auth/me", nil); err != nil {
		t.Fatal(err)
	}
}

func TestNewRejectsUnsafeEndpoints(t *testing.T) {
	for _, endpoint := range []string{
		"",
		"sandpi.example",
		"file:///tmp/sandpi",
		"https://user:secret@sandpi.example",
		"https://sandpi.example?token=secret",
	} {
		t.Run(endpoint, func(t *testing.T) {
			if _, err := New(endpoint, "", false, "", nil); err == nil {
				t.Fatalf("New(%q) succeeded", endpoint)
			}
		})
	}
}
