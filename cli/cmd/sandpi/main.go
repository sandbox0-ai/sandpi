package main

import (
	"context"
	"fmt"
	"os"

	"github.com/sandbox0-ai/sandpi/cli/internal/command"
)

var version = "dev"

func main() {
	app := command.New(command.Options{
		In:      os.Stdin,
		Out:     os.Stdout,
		Err:     os.Stderr,
		Version: version,
	})
	if err := app.ExecuteContext(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, command.FormatError(err))
		os.Exit(1)
	}
}
