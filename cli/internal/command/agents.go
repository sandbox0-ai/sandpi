package command

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	"github.com/sandbox0-ai/sandpi/cli/internal/api"
	"github.com/spf13/cobra"
)

const agentsPath = "/workspace/AGENTS.md"

func (a *App) agentsCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "agents",
		Short: "Read or replace the Environment's /workspace/AGENTS.md",
	}
	command.AddCommand(a.agentsGetCommand(), a.agentsSetCommand())
	return command
}

func (a *App) agentsGetCommand() *cobra.Command {
	var environmentID string
	var raw bool
	command := &cobra.Command{
		Use:   "get",
		Short: "Read /workspace/AGENTS.md",
		RunE: func(command *cobra.Command, _ []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			client, err := a.apiClient()
			if err != nil {
				return err
			}
			data, err := client.Data(command.Context(), http.MethodGet, workspaceIdeFilePath(environmentID, agentsPath), nil)
			if err != nil {
				return err
			}
			if !raw {
				return a.printJSON(data)
			}
			var file struct {
				Content string `json:"content"`
			}
			if err := json.Unmarshal(data, &file); err != nil {
				return fmt.Errorf("decode AGENTS.md response: %w", err)
			}
			content, err := base64.StdEncoding.DecodeString(file.Content)
			if err != nil {
				return fmt.Errorf("decode AGENTS.md content: %w", err)
			}
			_, err = a.options.Out.Write(content)
			return err
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().BoolVar(&raw, "raw", false, "write only decoded file contents")
	return command
}

func (a *App) agentsSetCommand() *cobra.Command {
	var environmentID string
	var inputPath string
	var baseRevision string
	var force bool
	command := &cobra.Command{
		Use:   "set",
		Short: "Create or replace /workspace/AGENTS.md",
		RunE: func(command *cobra.Command, _ []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			if baseRevision != "" && force {
				return errors.New("--base-revision and --force cannot be used together")
			}
			content, err := readInput(a.options.In, inputPath, 5*1024*1024)
			if err != nil {
				return err
			}
			client, err := a.apiClient()
			if err != nil {
				return err
			}
			revision := baseRevision
			if revision == "" {
				var existed bool
				revision, existed, err = prepareAgentsRevision(command, client, environmentID)
				if err != nil {
					return err
				}
				if existed && !force {
					return errors.New("AGENTS.md already exists; read and merge it, then pass --base-revision, or use --force to replace it")
				}
			}
			return a.data(command.Context(), http.MethodPut, workspaceIdeFilePath(environmentID, agentsPath), map[string]string{
				"encoding":     "base64",
				"content":      base64.StdEncoding.EncodeToString(content),
				"baseRevision": revision,
			})
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().StringVarP(&inputPath, "file", "f", "-", "local file path or - for stdin")
	command.Flags().StringVar(&baseRevision, "base-revision", "", "expected Workspace file revision")
	command.Flags().BoolVar(&force, "force", false, "replace an existing AGENTS.md using its current revision")
	return command
}

func prepareAgentsRevision(command *cobra.Command, client *api.Client, environmentID string) (string, bool, error) {
	data, err := client.Data(command.Context(), http.MethodGet, workspaceIdeFilePath(environmentID, agentsPath), nil)
	existed := err == nil
	if err != nil {
		var apiError *api.Error
		if !errors.As(err, &apiError) || apiError.StatusCode != http.StatusNotFound {
			return "", false, err
		}
		_, createErr := client.Data(command.Context(), http.MethodPost, environmentPath(environmentID)+"/ide/entries", map[string]string{
			"parentPath": "/workspace",
			"name":       "AGENTS.md",
			"kind":       "file",
		})
		if createErr != nil {
			if !errors.As(createErr, &apiError) || apiError.StatusCode != http.StatusConflict {
				return "", false, createErr
			}
			existed = true
		}
		data, err = client.Data(command.Context(), http.MethodGet, workspaceIdeFilePath(environmentID, agentsPath), nil)
		if err != nil {
			return "", false, err
		}
	}
	var file struct {
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(data, &file); err != nil || file.Revision == "" {
		return "", false, errors.New("Sandpi returned an invalid AGENTS.md revision")
	}
	return file.Revision, existed, nil
}

func workspaceIdeFilePath(environmentID, filePath string) string {
	return environmentPath(environmentID) + "/ide/file?path=" + url.QueryEscape(filePath)
}
