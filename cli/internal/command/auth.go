package command

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"

	localconfig "github.com/sandbox0-ai/sandpi/cli/internal/config"
	"github.com/spf13/cobra"
)

func (a *App) authCommand() *cobra.Command {
	command := &cobra.Command{Use: "auth", Short: "Authenticate the Sandpi CLI"}
	command.AddCommand(a.authLoginCommand(), a.authStatusCommand(), a.authLogoutCommand())
	return command
}

func (a *App) authStatusCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show the current Sandpi principal",
		RunE: func(command *cobra.Command, _ []string) error {
			return a.data(command.Context(), http.MethodGet, "/api/v1/auth/me", nil)
		},
	}
}

func (a *App) authLoginCommand() *cobra.Command {
	var noOpen bool
	var callbackURL string
	command := &cobra.Command{
		Use:   "login",
		Short: "Sign in through the deployment's browser authentication",
		Long:  "Start Sandpi native PKCE authentication. After browser sign-in, copy the sandpi:// callback URL from the browser and paste it into this command.",
		RunE: func(command *cobra.Command, _ []string) error {
			client, err := a.apiClient()
			if err != nil {
				return err
			}
			verifier, err := randomBase64URL(32)
			if err != nil {
				return err
			}
			state, err := randomBase64URL(32)
			if err != nil {
				return err
			}
			prepared, err := client.Data(command.Context(), http.MethodPost, "/api/v1/auth/native/prepare", map[string]string{
				"returnTo": "/",
				"verifier": verifier,
				"state":    state,
			})
			if err != nil {
				return err
			}
			var flow struct {
				AuthorizationURL string `json:"authorizationUrl"`
			}
			if err := json.Unmarshal(prepared, &flow); err != nil || flow.AuthorizationURL == "" {
				return errors.New("Sandpi returned an invalid native authentication flow")
			}
			fmt.Fprintf(a.options.Err, "Open this URL to sign in:\n%s\n", flow.AuthorizationURL)
			if !noOpen {
				_ = openBrowser(flow.AuthorizationURL)
			}
			callback := strings.TrimSpace(callbackURL)
			if callback == "" {
				fmt.Fprint(a.options.Err, "Paste the sandpi:// callback URL: ")
				line, readErr := bufio.NewReader(a.options.In).ReadString('\n')
				if readErr != nil && strings.TrimSpace(line) == "" {
					return fmt.Errorf("read callback URL: %w", readErr)
				}
				callback = strings.TrimSpace(line)
			}
			attemptID, code, err := parseNativeCallback(callback, state)
			if err != nil {
				return err
			}
			response, err := client.Do(command.Context(), http.MethodPost, "/api/v1/auth/native/complete", map[string]string{
				"attemptId": attemptID,
				"code":      code,
				"verifier":  verifier,
			})
			if err != nil {
				return err
			}
			sessionCookie := ""
			for _, cookie := range (&http.Response{Header: response.Header}).Cookies() {
				if cookie.Name == "sandpi_session" {
					sessionCookie = cookie.Value
					break
				}
			}
			if err := localconfig.Save(localconfig.Config{
				Endpoint:      client.Endpoint(),
				SessionCookie: sessionCookie,
			}); err != nil {
				return err
			}
			a.resetClient()
			return a.data(command.Context(), http.MethodGet, "/api/v1/auth/me", nil)
		},
	}
	command.Flags().BoolVar(&noOpen, "no-open", false, "do not open the system browser")
	command.Flags().StringVar(&callbackURL, "callback-url", "", "completed callback URL (primarily for non-interactive clients)")
	return command
}

func (a *App) authLogoutCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "End the stored Sandpi CLI session",
		RunE: func(command *cobra.Command, _ []string) error {
			client, err := a.apiClient()
			if err != nil {
				return err
			}
			_, requestErr := client.Do(command.Context(), http.MethodPost, "/api/v1/auth/logout", nil)
			if err := localconfig.Save(localconfig.Config{
				Endpoint:  client.Endpoint(),
				SignedOut: true,
			}); err != nil {
				return err
			}
			a.resetClient()
			if requestErr != nil {
				return requestErr
			}
			return a.printJSON(map[string]bool{"loggedOut": true})
		},
	}
}

func randomBase64URL(size int) (string, error) {
	content := make([]byte, size)
	if _, err := rand.Read(content); err != nil {
		return "", fmt.Errorf("generate authentication secret: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(content), nil
}

func parseNativeCallback(value, expectedState string) (string, string, error) {
	callback, err := url.Parse(value)
	if err != nil || callback.Scheme != "sandpi" || callback.Host != "auth" || callback.Path != "/callback" {
		return "", "", errors.New("invalid Sandpi native authentication callback URL")
	}
	query := callback.Query()
	if query.Get("state") != expectedState {
		return "", "", errors.New("Sandpi authentication callback state does not match")
	}
	attemptID := query.Get("attempt_id")
	code := query.Get("code")
	if attemptID == "" || code == "" {
		return "", "", errors.New("Sandpi authentication callback is incomplete")
	}
	return attemptID, code, nil
}

func openBrowser(target string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", target)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		command = exec.Command("xdg-open", target)
	}
	return command.Start()
}
