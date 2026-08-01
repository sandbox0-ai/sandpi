package command

import (
	"errors"
	"net/http"

	"github.com/spf13/cobra"
)

func (a *App) memoryCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "memory",
		Short: "Manage Environment Codex memory settings",
		Long:  "Manage supported Codex memory settings. Native memory content is not exported or imported.",
	}
	command.AddCommand(a.memoryGetCommand(), a.memorySetCommand(), a.memoryResetCommand())
	return command
}

func (a *App) memoryGetCommand() *cobra.Command {
	var environmentID string
	command := &cobra.Command{
		Use:   "get",
		Short: "Get memory settings",
		RunE: func(command *cobra.Command, _ []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			return a.data(command.Context(), http.MethodGet, memoryPath(environmentID), nil)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	return command
}

func (a *App) memorySetCommand() *cobra.Command {
	var environmentID string
	var inputPath string
	command := &cobra.Command{
		Use:   "set",
		Short: "Replace memory settings from JSON",
		RunE: func(command *cobra.Command, _ []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			body, err := readJSON(a.options.In, inputPath, 64*1024)
			if err != nil {
				return err
			}
			return a.data(command.Context(), http.MethodPut, memoryPath(environmentID), body)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().StringVarP(&inputPath, "file", "f", "-", "JSON file path or - for stdin")
	return command
}

func (a *App) memoryResetCommand() *cobra.Command {
	var environmentID string
	var yes bool
	command := &cobra.Command{
		Use:   "reset",
		Short: "Reset native Environment memories",
		RunE: func(command *cobra.Command, _ []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			if err := requireYes(yes); err != nil {
				return err
			}
			return a.data(command.Context(), http.MethodDelete, memoryPath(environmentID), nil)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().BoolVar(&yes, "yes", false, "confirm memory reset")
	return command
}

func memoryPath(environmentID string) string {
	return environmentPath(environmentID) + "/harnesses/codex/memories"
}
