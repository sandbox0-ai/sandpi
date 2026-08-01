package command

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"runtime"

	localconfig "github.com/sandbox0-ai/sandpi/cli/internal/config"
	"github.com/sandbox0-ai/sandpi/cli/internal/deviceauth"
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
	command := &cobra.Command{
		Use:   "login",
		Short: "Sign in with the deployment's device authorization flow",
		Long:  "Start the deployment's OIDC Device Authorization Flow, open its verification page, and wait for the user to approve this CLI.",
		RunE: func(command *cobra.Command, _ []string) error {
			client, err := a.apiClient()
			if err != nil {
				return err
			}
			configured, err := client.Data(command.Context(), http.MethodGet, "/api/v1/auth/device/config", nil)
			if err != nil {
				return err
			}
			var configuration struct {
				Mode     string `json:"mode"`
				Issuer   string `json:"issuer"`
				ClientID string `json:"clientId"`
				Scopes   string `json:"scopes"`
			}
			if err := json.Unmarshal(configured, &configuration); err != nil {
				return errors.New("Sandpi returned an invalid device authorization configuration")
			}
			if configuration.Mode == "admin" {
				if err := localconfig.Save(localconfig.Config{Endpoint: client.Endpoint()}); err != nil {
					return err
				}
				a.resetClient()
				return a.data(command.Context(), http.MethodGet, "/api/v1/auth/me", nil)
			}
			if configuration.Mode != "oidc" {
				return errors.New("Sandpi returned an unsupported authentication mode")
			}
			provider, err := deviceauth.New(
				configuration.Issuer,
				configuration.ClientID,
				configuration.Scopes,
				a.options.HTTPClient,
			)
			if err != nil {
				return err
			}
			flow, err := provider.Start(command.Context())
			if err != nil {
				return err
			}
			verificationURL := flow.VerificationURL()
			fmt.Fprintf(
				a.options.Err,
				"Open this URL to sign in:\n%s\nVerification code: %s\nWaiting for authorization...\n",
				verificationURL,
				flow.UserCode,
			)
			if !noOpen {
				_ = openBrowser(verificationURL)
			}
			tokens, err := provider.Poll(command.Context(), flow)
			if err != nil {
				return err
			}
			response, err := client.Do(command.Context(), http.MethodPost, "/api/v1/auth/device/complete", map[string]string{
				"accessToken": tokens.AccessToken,
				"idToken":     tokens.IDToken,
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
			if sessionCookie == "" {
				return errors.New("Sandpi did not return an authenticated session")
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
