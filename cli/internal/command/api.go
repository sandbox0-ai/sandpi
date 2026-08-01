package command

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/spf13/cobra"
)

func (a *App) apiCommand() *cobra.Command {
	var inputPath string
	command := &cobra.Command{
		Use:   "api <method> <path>",
		Short: "Call any Sandpi JSON API endpoint",
		Long:  "Low-level escape hatch for API capabilities that do not yet have a typed CLI command.",
		Args:  cobra.ExactArgs(2),
		RunE: func(command *cobra.Command, args []string) error {
			method := strings.ToUpper(args[0])
			switch method {
			case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete:
			default:
				return fmt.Errorf("unsupported HTTP method %q", method)
			}
			if !strings.HasPrefix(args[1], "/api/v1/") {
				return errors.New("API path must start with /api/v1/")
			}
			var body any
			if inputPath != "" {
				value, err := readJSON(a.options.In, inputPath, 16*1024*1024)
				if err != nil {
					return err
				}
				body = value
			}
			client, err := a.apiClient()
			if err != nil {
				return err
			}
			response, err := client.Do(command.Context(), method, args[1], body)
			if err != nil {
				return err
			}
			if len(response.Body) == 0 {
				return a.printJSON(nil)
			}
			if !json.Valid(response.Body) {
				return errors.New("Sandpi API returned invalid JSON")
			}
			return a.printJSON(json.RawMessage(response.Body))
		},
	}
	command.Flags().StringVarP(&inputPath, "file", "f", "", "JSON request file path or - for stdin")
	return command
}
