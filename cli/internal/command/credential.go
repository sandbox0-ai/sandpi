package command

import (
	"errors"
	"net/http"
	"net/url"

	"github.com/spf13/cobra"
)

func (a *App) credentialCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "credential",
		Short: "Manage secret-injecting Environment egress credentials",
		Long:  "Manage Environment egress credentials. Secret material is accepted only on create or rotate and is never returned by Sandpi.",
	}
	command.AddCommand(
		a.credentialListCommand(),
		a.credentialGetCommand(),
		a.credentialWriteCommand("create"),
		a.credentialWriteCommand("update"),
		a.credentialWriteCommand("rotate"),
		a.credentialDeleteCommand(),
	)
	return command
}

func (a *App) credentialListCommand() *cobra.Command {
	var environmentID string
	command := &cobra.Command{
		Use:   "list",
		Short: "List secret-free credential projections",
		RunE: func(command *cobra.Command, _ []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			return a.data(command.Context(), http.MethodGet, credentialCollectionPath(environmentID), nil)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	return command
}

func (a *App) credentialGetCommand() *cobra.Command {
	var environmentID string
	command := &cobra.Command{
		Use:   "get <credential-id>",
		Short: "Get one secret-free credential projection",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			return a.data(command.Context(), http.MethodGet, credentialPath(environmentID, args[0]), nil)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	return command
}

func (a *App) credentialWriteCommand(operation string) *cobra.Command {
	var environmentID string
	var inputPath string
	use := operation
	short := "Create an egress credential from JSON"
	method := http.MethodPost
	if operation != "create" {
		use += " <credential-id>"
		method = http.MethodPut
		if operation == "update" {
			short = "Replace credential configuration without reading or changing its secret"
		} else {
			short = "Rotate credential secret material"
		}
	}
	command := &cobra.Command{
		Use:   use,
		Short: short,
		Args: func(command *cobra.Command, args []string) error {
			if operation == "create" {
				return cobra.NoArgs(command, args)
			}
			return cobra.ExactArgs(1)(command, args)
		},
		RunE: func(command *cobra.Command, args []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			body, err := readJSON(a.options.In, inputPath, 3*1024*1024)
			if err != nil {
				return err
			}
			path := credentialCollectionPath(environmentID)
			if operation != "create" {
				path = credentialPath(environmentID, args[0])
				if operation == "rotate" {
					path += "/material"
				}
			}
			return a.data(command.Context(), method, path, body)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().StringVarP(&inputPath, "file", "f", "-", "JSON file path or - for stdin")
	return command
}

func (a *App) credentialDeleteCommand() *cobra.Command {
	var environmentID string
	var yes bool
	command := &cobra.Command{
		Use:   "delete <credential-id>",
		Short: "Delete an egress credential and its Sandbox0 secret source",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if environmentID == "" {
				return errors.New("--environment is required")
			}
			if err := requireYes(yes); err != nil {
				return err
			}
			return a.data(command.Context(), http.MethodDelete, credentialPath(environmentID, args[0]), nil)
		},
	}
	command.Flags().StringVarP(&environmentID, "environment", "e", "", "Environment id")
	command.Flags().BoolVar(&yes, "yes", false, "confirm deletion")
	return command
}

func credentialCollectionPath(environmentID string) string {
	return environmentPath(environmentID) + "/egress-credentials"
}

func credentialPath(environmentID, credentialID string) string {
	return credentialCollectionPath(environmentID) + "/" + url.PathEscape(credentialID)
}
