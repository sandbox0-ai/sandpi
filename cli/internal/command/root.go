package command

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/sandbox0-ai/sandpi/cli/internal/api"
	localconfig "github.com/sandbox0-ai/sandpi/cli/internal/config"
	"github.com/spf13/cobra"
)

const defaultEndpoint = "https://sandpi.ai"

type Options struct {
	In         io.Reader
	Out        io.Writer
	Err        io.Writer
	Version    string
	HTTPClient *http.Client
}

type App struct {
	options Options
	root    *cobra.Command

	endpoint string
	compact  bool
	client   *api.Client
}

func New(options Options) *App {
	if options.In == nil {
		options.In = strings.NewReader("")
	}
	if options.Out == nil {
		options.Out = io.Discard
	}
	if options.Err == nil {
		options.Err = io.Discard
	}
	app := &App{options: options}
	root := &cobra.Command{
		Use:           "sandpi",
		Short:         "Operate Sandpi Environments from a terminal or coding agent",
		SilenceErrors: true,
		SilenceUsage:  true,
		Version:       options.Version,
	}
	root.SetIn(options.In)
	root.SetOut(options.Out)
	root.SetErr(options.Err)
	root.PersistentFlags().StringVar(&app.endpoint, "endpoint", "", "Sandpi deployment URL (or SANDPI_ENDPOINT)")
	root.PersistentFlags().BoolVar(&app.compact, "compact", false, "emit compact JSON")
	root.AddCommand(
		app.authCommand(),
		app.environmentCommand(),
		app.agentsCommand(),
		app.skillCommand(),
		app.mcpCommand(),
		app.memoryCommand(),
		app.credentialCommand(),
		app.apiCommand(),
	)
	app.root = root
	return app
}

func (a *App) ExecuteContext(ctx context.Context) error {
	a.root.SetContext(ctx)
	return a.root.Execute()
}

func (a *App) apiClient() (*api.Client, error) {
	if a.client != nil {
		return a.client, nil
	}
	configured, err := localconfig.Load()
	if err != nil {
		return nil, err
	}
	endpoint := firstNonempty(a.endpoint, os.Getenv("SANDPI_ENDPOINT"), configured.Endpoint, defaultEndpoint)
	session := firstNonempty(os.Getenv("SANDPI_SESSION_COOKIE"), configured.SessionCookie)
	client, err := api.New(
		endpoint,
		session,
		configured.SignedOut && session == "",
		"sandpi-cli/"+a.options.Version,
		a.options.HTTPClient,
	)
	if err != nil {
		return nil, err
	}
	a.client = client
	return client, nil
}

func (a *App) resetClient() {
	a.client = nil
}

func (a *App) printJSON(value any) error {
	var content []byte
	var err error
	if raw, ok := value.(json.RawMessage); ok {
		if a.compact {
			buffer := &bytes.Buffer{}
			err = json.Compact(buffer, raw)
			content = buffer.Bytes()
		} else {
			content, err = json.MarshalIndent(raw, "", "  ")
		}
	} else if a.compact {
		content, err = json.Marshal(value)
	} else {
		content, err = json.MarshalIndent(value, "", "  ")
	}
	if err != nil {
		return fmt.Errorf("encode output: %w", err)
	}
	_, err = fmt.Fprintln(a.options.Out, string(content))
	return err
}

func (a *App) data(ctx context.Context, method, path string, body any) error {
	client, err := a.apiClient()
	if err != nil {
		return err
	}
	data, err := client.Data(ctx, method, path, body)
	if err != nil {
		return err
	}
	return a.printJSON(data)
}

func readInput(input io.Reader, path string, limit int64) ([]byte, error) {
	var reader io.Reader
	if path == "-" {
		reader = input
	} else {
		file, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("open %s: %w", path, err)
		}
		defer file.Close()
		reader = file
	}
	content, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read input: %w", err)
	}
	if int64(len(content)) > limit {
		return nil, fmt.Errorf("input exceeds %d bytes", limit)
	}
	return content, nil
}

func readJSON(input io.Reader, path string, limit int64) (json.RawMessage, error) {
	content, err := readInput(input, path, limit)
	if err != nil {
		return nil, err
	}
	if !json.Valid(content) {
		return nil, errors.New("input must be valid JSON")
	}
	return json.RawMessage(content), nil
}

func requireYes(yes bool) error {
	if !yes {
		return errors.New("destructive operation requires --yes")
	}
	return nil
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func FormatError(err error) string {
	var apiError *api.Error
	if errors.As(err, &apiError) {
		encoded, marshalErr := json.Marshal(apiError)
		if marshalErr == nil {
			return string(encoded)
		}
	}
	encoded, marshalErr := json.Marshal(map[string]any{
		"code":    "cli_error",
		"message": err.Error(),
	})
	if marshalErr == nil {
		return string(encoded)
	}
	return err.Error()
}
