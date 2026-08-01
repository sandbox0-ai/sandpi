package command

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/spf13/cobra"
)

func (a *App) environmentCommand() *cobra.Command {
	command := &cobra.Command{Use: "environment", Short: "Manage Sandpi Environments"}
	command.AddCommand(
		&cobra.Command{
			Use:   "list",
			Short: "List Environments",
			RunE: func(command *cobra.Command, _ []string) error {
				return a.data(command.Context(), http.MethodGet, "/api/v1/environments", nil)
			},
		},
		a.environmentGetCommand(),
		a.environmentCreateCommand(),
		a.environmentDeleteCommand(),
		a.environmentWaitCommand(),
	)
	return command
}

func (a *App) environmentGetCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "get <environment-id>",
		Short: "Get one Environment",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			return a.data(command.Context(), http.MethodGet, environmentPath(args[0]), nil)
		},
	}
}

func (a *App) environmentCreateCommand() *cobra.Command {
	var name string
	command := &cobra.Command{
		Use:   "create",
		Short: "Create an empty Environment",
		RunE: func(command *cobra.Command, _ []string) error {
			if name == "" {
				return errors.New("--name is required")
			}
			return a.data(command.Context(), http.MethodPost, "/api/v1/environments", map[string]string{"name": name})
		},
	}
	command.Flags().StringVar(&name, "name", "", "Environment name")
	return command
}

func (a *App) environmentDeleteCommand() *cobra.Command {
	var yes bool
	command := &cobra.Command{
		Use:   "delete <environment-id>",
		Short: "Delete an Environment",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if err := requireYes(yes); err != nil {
				return err
			}
			return a.data(command.Context(), http.MethodDelete, environmentPath(args[0]), nil)
		},
	}
	command.Flags().BoolVar(&yes, "yes", false, "confirm deletion")
	return command
}

func (a *App) environmentWaitCommand() *cobra.Command {
	var timeout time.Duration
	var interval time.Duration
	command := &cobra.Command{
		Use:   "wait <environment-id>",
		Short: "Wait until Environment provisioning finishes",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if timeout <= 0 || interval <= 0 {
				return errors.New("--timeout and --interval must be positive")
			}
			ctx, cancel := context.WithTimeout(command.Context(), timeout)
			defer cancel()
			client, err := a.apiClient()
			if err != nil {
				return err
			}
			for {
				data, err := client.Data(ctx, http.MethodGet, environmentPath(args[0]), nil)
				if err != nil {
					return err
				}
				var state struct {
					Status string `json:"status"`
				}
				if err := json.Unmarshal(data, &state); err != nil {
					return fmt.Errorf("decode Environment: %w", err)
				}
				if state.Status == "ready" {
					return a.printJSON(data)
				}
				if state.Status == "error" || state.Status == "archived" {
					if printErr := a.printJSON(data); printErr != nil {
						return printErr
					}
					return fmt.Errorf("Environment entered %s state", state.Status)
				}
				select {
				case <-ctx.Done():
					return fmt.Errorf("wait for Environment: %w", ctx.Err())
				case <-time.After(interval):
				}
			}
		},
	}
	command.Flags().DurationVar(&timeout, "timeout", 5*time.Minute, "maximum wait duration")
	command.Flags().DurationVar(&interval, "interval", time.Second, "poll interval")
	return command
}

func environmentPath(environmentID string) string {
	return "/api/v1/environments/" + url.PathEscape(environmentID)
}
