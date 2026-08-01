package command

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	"github.com/spf13/cobra"
)

func (a *App) mcpCommand() *cobra.Command {
	command := &cobra.Command{Use: "mcp", Short: "Manage Environment Codex MCP servers"}
	command.AddCommand(
		a.mcpListCommand(),
		a.mcpGetCommand(),
		a.mcpPutCommand(),
		a.mcpDeleteCommand(),
		a.mcpEnabledCommand(true),
		a.mcpEnabledCommand(false),
		a.mcpOAuthLoginCommand(),
	)
	return command
}

func (a *App) mcpListCommand() *cobra.Command {
	var environmentID string
	var full bool
	command := &cobra.Command{
		Use:   "list",
		Short: "List MCP servers",
		RunE: func(command *cobra.Command, _ []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			path := mcpCollectionPath(environmentID)
			if full {
				path += "?detail=full"
			}
			return a.data(command.Context(), http.MethodGet, path, nil)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().BoolVar(&full, "full", false, "include tools and resources")
	return command
}

func (a *App) mcpGetCommand() *cobra.Command {
	var environmentID string
	var full bool
	command := &cobra.Command{
		Use:   "get <name>",
		Short: "Get one MCP server's secret-free inventory",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			server, err := a.getMCP(command, environmentID, args[0], full)
			if err != nil {
				return err
			}
			return a.printJSON(server)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().BoolVar(&full, "full", false, "include tools and resources")
	return command
}

func (a *App) mcpPutCommand() *cobra.Command {
	var environmentID string
	var inputPath string
	command := &cobra.Command{
		Use:   "put <name>",
		Short: "Create or replace one MCP definition from JSON",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			body, err := readJSON(a.options.In, inputPath, 1024*1024)
			if err != nil {
				return err
			}
			return a.data(command.Context(), http.MethodPut, mcpPath(environmentID, args[0]), body)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().StringVarP(&inputPath, "file", "f", "-", "JSON file path or - for stdin")
	return command
}

func (a *App) mcpDeleteCommand() *cobra.Command {
	var environmentID string
	var yes bool
	command := &cobra.Command{
		Use:   "delete <name>",
		Short: "Delete one user-managed MCP server",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			if err := requireYes(yes); err != nil {
				return err
			}
			return a.data(command.Context(), http.MethodDelete, mcpPath(environmentID, args[0]), nil)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().BoolVar(&yes, "yes", false, "confirm deletion")
	return command
}

func (a *App) mcpEnabledCommand(enabled bool) *cobra.Command {
	var environmentID string
	verb := "enable"
	if !enabled {
		verb = "disable"
	}
	command := &cobra.Command{
		Use:   verb + " <name>",
		Short: verb + " one user-managed MCP server",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			return a.data(command.Context(), http.MethodPut, mcpPath(environmentID, args[0])+"/enabled", map[string]bool{"enabled": enabled})
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	return command
}

func (a *App) mcpOAuthLoginCommand() *cobra.Command {
	var environmentID string
	command := &cobra.Command{
		Use:   "oauth-login <name>",
		Short: "Start OAuth for one configured MCP server",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			return a.data(command.Context(), http.MethodPost, mcpPath(environmentID, args[0])+"/oauth/login", nil)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	return command
}

func (a *App) getMCP(command *cobra.Command, environmentID, name string, full bool) (json.RawMessage, error) {
	client, err := a.apiClient()
	if err != nil {
		return nil, err
	}
	path := mcpCollectionPath(environmentID)
	if full {
		path += "?detail=full"
	}
	data, err := client.Data(command.Context(), http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	var inventory struct {
		Servers []json.RawMessage `json:"servers"`
	}
	if err := json.Unmarshal(data, &inventory); err != nil {
		return nil, fmt.Errorf("decode MCP inventory: %w", err)
	}
	for _, server := range inventory.Servers {
		var identity struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(server, &identity) == nil && identity.Name == name {
			return server, nil
		}
	}
	return nil, fmt.Errorf("MCP server %q was not found", name)
}

func mcpCollectionPath(environmentID string) string {
	return environmentPath(environmentID) + "/harnesses/codex/mcp-servers"
}

func mcpPath(environmentID, name string) string {
	return mcpCollectionPath(environmentID) + "/" + url.PathEscape(name)
}
